"""Conservative, explainable V0 baselines. No diagnosis or calibrated probability."""
from datetime import datetime, timedelta, timezone
from statistics import median

MODEL_VERSION='v0.1-ndvi-local-baseline'
LIMITATIONS=[
    '异常候选不是病虫害、冻害或积水诊断，需要现场核验。',
    '未作物候校正；收获、播期和管理变化也可能触发异常。',
    '分数不是概率，阈值未用真实田块事件校准。',
    '当前仅使用同源NDVI，SAR和气象已可存储但尚未融合。',
]

def eligible(o):
    q=o['quality']
    return o['source']=='sentinel2' and o['features'].get('ndvi') is not None and q['usable'] and q['valid_fraction']>=0.6 and q.get('cloud_fraction') is not None and q['cloud_fraction']<=0.4

def evaluate(observations, method, now=None):
    now=now or datetime.now(timezone.utc)
    good=sorted([o for o in observations if eligible(o) and datetime.fromisoformat(o['observed_at'])<=now],key=lambda o:o['observed_at'])
    count=len(good)
    base={'observation_count':count,'risk':None}
    if not good:
        return {**base,'status':'insufficient_data','message':'没有通过质量门槛的Sentinel-2 NDVI观测，不能判断地块状态。'}
    latest=good[-1]
    latest_at=datetime.fromisoformat(latest['observed_at'])
    if now-latest_at>timedelta(days=14):
        return {**base,'status':'stale','message':'最新可用光学观测已超过14天，不生成新的风险候选。'}
    # Never compare multiple products from one acquisition or inconsistent processors.
    peers=[o for o in good[:-1] if o['provenance']['collection']==latest['provenance']['collection'] and o['provenance']['processing_version']==latest['provenance']['processing_version'] and 0<(latest_at-datetime.fromisoformat(o['observed_at'])).total_seconds()<=90*86400]
    daily={}
    for o in peers:
        key=o['observed_at'][:10]
        if key!=latest['observed_at'][:10]: daily[key]=o
    history=sorted(daily.values(),key=lambda o:o['observed_at'])
    minimum=20 if method=='isolation_forest' else 5
    if len(history)<minimum or (latest_at-datetime.fromisoformat(history[0]['observed_at'])).days<28:
        return {**base,'status':'insufficient_data','message':f'需要90天内至少{minimum}个不同日期、同集合/处理版本的历史NDVI样本，跨度至少28天。当前{len(history)}个。'}
    values=[o['features']['ndvi'] for o in history]
    center=median(values);mad=median(abs(v-center) for v in values)
    value=latest['features']['ndvi'];drop=center-value
    score=drop/max(1.4826*mad,0.03)
    flagged=drop>=0.1 and score>=3
    if method=='isolation_forest':
        from sklearn.ensemble import IsolationForest
        model=IsolationForest(n_estimators=100,contamination='auto',random_state=42,n_jobs=1)
        model.fit([[v] for v in values])
        decision=float(model.decision_function([[value]])[0])
        flagged=decision<0 and drop>=0.1
        score=-decision
    evidence={'metric':'ndvi','latest_value':value,'baseline_median':round(center,6),'baseline_mad':round(mad,6),'absolute_drop':round(drop,6),'score':round(score,6),'baseline_count':len(history),'baseline_observation_ids':[o['id'] for o in history],'latest_observation_id':latest['id'],'window_days':90,'limitations':LIMITATIONS}
    if not flagged:
        return {**base,'status':'not_flagged','message':'本次基线未发现达到阈值的下降；不代表已确认健康。'}
    return {**base,'status':'candidate','message':'发现NDVI下降候选，建议安排巡田核验。','risk':{'observation_id':latest['id'],'priority':'high' if drop>=0.2 else 'medium','summary':'NDVI较近期同源基线下降，原因待现场核验','evidence':evidence}}
