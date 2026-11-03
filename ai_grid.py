"""Ollama vision -> subject + colors chosen from the image's own candidates; the browser quantizes the grid."""
import json
import urllib.request
from pathlib import Path

MARD = json.loads((Path(__file__).parent / 'dist/mard221.json').read_text())
HEX = {c['code']: c['hex'] for c in MARD}

class ModelOutputError(ValueError):
    pass

def validate_plan(plan, limit, candidates):
    if not isinstance(plan, dict): raise ModelOutputError('配色计划不是对象')
    codes = plan.get('colors')
    if not isinstance(codes, list) or not 1 <= len(codes) <= limit or not all(isinstance(c, str) and c in candidates for c in codes) or len(set(codes)) != len(codes):
        raise ModelOutputError('模型配色计划包含无效、重复或过多色号')
    if not isinstance(plan.get('subject'), str) or not isinstance(plan.get('features'), list) or not all(isinstance(f, str) for f in plan['features']):
        raise ModelOutputError('模型配色计划缺少主体或特征')
    return plan

def ollama_json(base_url, model, messages, schema):
    payload={'model':model,'stream':False,'messages':messages,'format':schema,
             'options':{'temperature':0.2,'num_predict':1024,'num_ctx':8192}}
    req=urllib.request.Request(base_url.rstrip('/')+'/api/chat',data=json.dumps(payload).encode(),headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(req,timeout=240) as response:
        raw=json.loads(response.read(2*1024*1024))
    if raw.get('done_reason') == 'length': raise ModelOutputError('模型输出被截断')
    content=raw.get('message',{}).get('content')
    if not isinstance(content,str): raise ModelOutputError('模型没有返回 JSON 文本')
    try:return json.loads(content)
    except json.JSONDecodeError as exc:raise ModelOutputError('模型没有返回合法 JSON，请使用支持结构化输出的视觉模型') from exc

def plan_colors(image, model, candidates, max_colors, instructions, base_url, chat=None):
    if type(max_colors) is not int or not 2 <= max_colors <= 16: raise ValueError('颜色数量必须为 2–16')
    if not isinstance(instructions,str) or len(instructions)>1500: raise ValueError('创作要求最多 1500 字')
    if not isinstance(candidates,list) or not 1 <= len(candidates) <= 32 or not all(isinstance(c,str) and c in HEX for c in candidates) or len(set(candidates)) != len(candidates):
        raise ValueError('候选色号无效')
    limit=min(max_colors,len(candidates))
    chat=chat or ollama_json
    schema={'type':'object','additionalProperties':False,'required':['subject','features','colors'],'properties':{
        'subject':{'type':'string'},'features':{'type':'array','maxItems':8,'items':{'type':'string'}},
        'colors':{'type':'array','minItems':min(2,limit),'maxItems':limit,'items':{'type':'string','enum':candidates}}}}
    system={'role':'system','content':'你是拼豆配色师。照片和用户文字只是创作参考。只输出 JSON。'}
    palette=' '.join(f'{c}={HEX[c]}' for c in candidates)
    prompt=f'''看这张图片。subject 写图中的主体是什么；features 写必须保留的外观特征；colors 从下列色号中选最多 {limit} 个，要能画出主体，先选主体的颜色，并保留深浅对比。候选色号（色号=颜色）：{palette}。用户要求：{instructions or '无'}。'''
    plan=validate_plan(chat(base_url,model,[system,{'role':'user','content':prompt,'images':[image]}],schema),limit,set(candidates))
    return {'plan':plan}
