"""Local frontend + fixed-origin Ollama API; no external Python dependencies."""
import os, json, urllib.request, urllib.error, base64, threading
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from functools import partial
from pathlib import Path
from ai_grid import plan_colors, ModelOutputError
ROOT=Path(__file__).parent
APP_VERSION='20261103-v10'
AI_LOCK=threading.Lock()
class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control','no-store, max-age=0')
        super().end_headers()
    def do_GET(self):
        if self.path == '/api/status': return self.reply(200,{'backend':True,'aiGrid':True,'palette':'MARD 221','version':APP_VERSION})
        super().do_GET()
    def do_POST(self):
        if self.path not in ['/api/analyze','/api/plan-colors']: return self.reply(404,{'error':'接口不存在'})
        origin=self.headers.get('Origin')
        if origin and origin != 'http://'+self.headers.get('Host',''): return self.reply(403,{'error':'不允许跨站调用'})
        locked=False
        try:
            length=int(self.headers.get('Content-Length','0'))
            if not 0<length<=8*1024*1024:return self.reply(413,{'error':'图片请求过大'})
            body=json.loads(self.rfile.read(length))
            if not isinstance(body,dict):raise ValueError('请求必须是 JSON 对象')
            image=body.get('image','');model=body.get('model','granite3.2-vision')
            if not isinstance(image,str) or not isinstance(model,str) or not 1<=len(model)<=120:raise ValueError('图片或模型参数无效')
            decoded=base64.b64decode(image,validate=True)
            if not (decoded.startswith(b'\x89PNG\r\n\x1a\n') or decoded.startswith(b'\xff\xd8')):raise ValueError('仅支持 PNG 或 JPEG')
            locked=AI_LOCK.acquire(blocking=False)
            if not locked:return self.reply(429,{'error':'已有 AI 任务正在执行，请稍后重试'})
            base_url=os.environ.get('OLLAMA_URL','http://localhost:11434')
            if self.path=='/api/plan-colors':
                return self.reply(200,plan_colors(image,model,body.get('candidates'),body.get('maxColors',12),body.get('instructions',''),base_url))
            payload={'model':model,'stream':False,'messages':[{'role':'user','content':'用中文列出照片主体、必须保留的特征、可删除的细节、建议颜色。不要声称已经修改图片。','images':[image]}]}
            req=urllib.request.Request(base_url.rstrip('/')+'/api/chat',data=json.dumps(payload).encode(),headers={'Content-Type':'application/json'})
            with urllib.request.urlopen(req,timeout=240) as response:result=json.load(response)
            analysis=result.get('message',{}).get('content')
            if not isinstance(analysis,str):raise ModelOutputError('模型响应缺少文本')
            self.reply(200,{'analysis':analysis})
        except ModelOutputError as e:self.reply(422,{'error':str(e)+'；原图纸保留，可调整模型或缩小尺寸后重试。'})
        except (ValueError,TypeError) as e:self.reply(400,{'error':str(e)})
        except urllib.error.HTTPError as e:
            if e.code==404:self.reply(502,{'error':f'Ollama 中没有模型 {model}，请先执行：docker compose exec ollama ollama pull {model}（单独运行的 Ollama 用 ollama pull {model}）'})
            else:
                try:detail=json.loads(e.read(4096)).get('error','')
                except Exception:detail=''
                self.reply(502,{'error':f'Ollama 返回 HTTP {e.code}'+(f'：{detail[:300]}' if detail else '，请确认模型已下载且支持图片和结构化输出')})
        except Exception:self.reply(502,{'error':'无法连接 Ollama 或请求超时，请检查服务、模型和内存'})
        finally:
            if locked:AI_LOCK.release()
    def reply(self,status,body):
        data=json.dumps(body,ensure_ascii=False).encode();self.send_response(status);self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Content-Length',str(len(data)));self.end_headers()
        try:self.wfile.write(data)
        except (BrokenPipeError,ConnectionResetError):pass
if __name__=='__main__':
    print('Bead Studio: http://localhost:8080',flush=True)
    ThreadingHTTPServer(('0.0.0.0',8080),partial(Handler,directory=str(ROOT/'dist'))).serve_forever()
