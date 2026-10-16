# Deliberately print only status and safe machine codes; never provider error bodies.
import sys, json, re, urllib.request, urllib.error
key=sys.stdin.readline().strip()
req=urllib.request.Request('https://aigc.sankuai.com/v1/openai/native/chat/completions',data=json.dumps({'model':'deepseek-v4-flash','messages':[{'role':'user','content':'回复OK'}],'stream':False}).encode(),headers={'Authorization':'Bearer '+key,'Content-Type':'application/json'})
try:
 with urllib.request.urlopen(req,timeout=30) as r: print(json.dumps({'status':r.status,'retryAfter':r.headers.get('Retry-After')}))
except urllib.error.HTTPError as e:
 try: error=json.loads(e.read()).get('error',{})
 except Exception: error={}
 codes={k:v for k,v in error.items() if k in ['code','type'] and isinstance(v,str) and re.fullmatch(r'[a-zA-Z0-9_-]{1,64}',v)}
 print(json.dumps({'status':e.code,'retryAfter':e.headers.get('Retry-After'),'codes':codes}))
except Exception as e: print(json.dumps({'failureType':type(e).__name__}))
