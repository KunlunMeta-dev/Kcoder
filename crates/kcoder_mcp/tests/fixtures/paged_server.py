import json,sys,threading,queue
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
mode=sys.argv[1];scenario=sys.argv[2];events=queue.Queue()
def answer(m):
 if 'id' not in m:return None
 method=m['method'];params=m.get('params',{})
 if method=='initialize':result={'protocolVersion':params['protocolVersion'],'capabilities':{},'serverInfo':{'name':'owned-pager','version':'1'}}
 elif method=='tools/list':
  cursor=params.get('cursor')
  if scenario=='large':return {'jsonrpc':'2.0','id':m['id'],'result':{'tools':[{'name':'large','description':'x'*(17*1024*1024)}]}}
  if cursor and scenario=='failure':return {'jsonrpc':'2.0','id':m['id'],'error':{'code':-32000,'message':'owned middle page failure'}}
  result={'tools':[{'name':'second' if cursor else 'first','inputSchema':{'type':'object'}}]}
  if not cursor or scenario=='cycle':result['nextCursor']='next'
  if cursor and scenario=='cycle':result['tools']=[]
 elif method=='tools/call':result={'content':[{'type':'text','text':params['name']}],'isError':False}
 else:raise RuntimeError(method)
 return {'jsonrpc':'2.0','id':m['id'],'result':result}
if mode=='stdio':
 for line in sys.stdin:
  r=answer(json.loads(line))
  if r:print(json.dumps(r),flush=True)
else:
 class Handler(BaseHTTPRequestHandler):
  protocol_version='HTTP/1.1'
  def log_message(self,*args):pass
  def do_GET(self):
   self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers();self.wfile.write(b'event: endpoint\ndata: /messages\n\n');self.wfile.flush()
   while True:
    data=events.get();self.wfile.write(('event: message\ndata: '+json.dumps(data)+'\n\n').encode());self.wfile.flush()
  def do_POST(self):
   m=json.loads(self.rfile.read(int(self.headers['Content-Length'])));r=answer(m)
   if mode=='sse':
    if r:events.put(r)
    data=b'';status=202
   else:data=json.dumps(r).encode() if r else b'';status=200 if r else 202
   self.send_response(status);self.send_header('Content-Length',str(len(data)));self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(data)
 server=ThreadingHTTPServer(('127.0.0.1',0),Handler);print(server.server_port,flush=True);server.serve_forever()
