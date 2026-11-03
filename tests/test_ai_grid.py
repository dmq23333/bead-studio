import sys, unittest, json, threading, urllib.request, urllib.error, os, base64
from pathlib import Path
from functools import partial
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from ai_grid import plan_colors,validate_plan,ModelOutputError
from server import Handler,ROOT

class PlanTests(unittest.TestCase):
 def test_model_chooses_from_image_candidates(self):
  calls=[]
  def chat(base,model,messages,schema):
   calls.append((messages,schema))
   return {'subject':'猫','features':['耳朵'],'colors':['A1','H1']}
  p=plan_colors('base64','vision',['A1','H1','A2'],2,'只保留头像','http://test',chat)
  self.assertEqual(p['plan']['colors'],['A1','H1'])
  self.assertEqual(len(calls),1)
  messages,schema=calls[0]
  self.assertEqual(messages[1]['images'],['base64'])
  self.assertIn('A1=#FAF5CD',messages[1]['content'])
  self.assertEqual(schema['properties']['colors']['items']['enum'],['A1','H1','A2'])
  self.assertEqual(schema['properties']['colors']['maxItems'],2)
 def test_limits_and_invalid_plan(self):
  for colors in [['FAKE'],['A1','A1'],['A1','A2','A3'],[]]:
   with self.assertRaises(ModelOutputError):validate_plan({'subject':'猫','features':[],'colors':colors},2,{'A1','A2','A3'})
  with self.assertRaises(ModelOutputError):validate_plan({'subject':'猫','features':[],'colors':['H1']},2,{'A1'})
  for candidates in [None,[],['FAKE'],['A1','A1'],['A1']*33]:
   with self.assertRaises(ValueError):plan_colors('x','v',candidates,2,'','http://test')
  for max_colors in [True,1,17,'2']:
   with self.assertRaises(ValueError):plan_colors('x','v',['A1'],max_colors,'','http://test')
 def test_http_proxy_with_real_mock_upstream(self):
  class Mock(BaseHTTPRequestHandler):
   def do_POST(self):
    p=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
    assert p['stream'] is False and p['messages'][1]['images']
    result={'subject':'猫','features':['耳朵'],'colors':['A1']}
    b=json.dumps({'message':{'content':json.dumps(result)}}).encode();self.send_response(200);self.end_headers();self.wfile.write(b)
   def log_message(self,*a):pass
  mock=ThreadingHTTPServer(('127.0.0.1',0),Mock);app=ThreadingHTTPServer(('127.0.0.1',0),partial(Handler,directory=str(ROOT/'dist')))
  before=os.environ.get('OLLAMA_URL');os.environ['OLLAMA_URL']=f'http://127.0.0.1:{mock.server_port}'
  for server in [mock,app]:threading.Thread(target=server.serve_forever,daemon=True).start()
  try:
   url=f'http://127.0.0.1:{app.server_port}'
   self.assertTrue(json.load(urllib.request.urlopen(url+'/api/status'))['aiGrid'])
   body={'candidates':['A1','H1'],'maxColors':2,'image':base64.b64encode(b'\x89PNG\r\n\x1a\nmock').decode(),'model':'mock'}
   def post(b,headers=None):return urllib.request.urlopen(urllib.request.Request(url+'/api/plan-colors',data=json.dumps(b).encode(),headers=headers or {'Content-Type':'application/json'}))
   result=json.load(post(body));self.assertEqual(result['plan']['colors'],['A1'])
   with self.assertRaises(urllib.error.HTTPError) as err:post(dict(body,candidates=['FAKE']))
   self.assertEqual(err.exception.code,400)
   with self.assertRaises(urllib.error.HTTPError) as err:post(body,{'Origin':'http://untrusted.example'})
   self.assertEqual(err.exception.code,403)
  finally:
   for server in [app,mock]:server.shutdown();server.server_close()
   if before is None:os.environ.pop('OLLAMA_URL',None)
   else:os.environ['OLLAMA_URL']=before
if __name__=='__main__':unittest.main()
