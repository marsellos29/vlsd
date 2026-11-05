// Сервер: роздає сайт і проксує офіційні API Нової пошти та Укрпошти (ключі лишаються на сервері).
const http=require('http'),fs=require('fs'),path=require('path');
try{for(const l of fs.readFileSync(path.join(__dirname,'.env'),'utf8').split(/\r?\n/)){const m=l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);if(m&&!(m[1] in process.env))process.env[m[1]]=m[2].replace(/^["']|["']$/g,'')}}catch{}
const PORT=process.env.PORT||3000,HOST=process.env.HOST||'0.0.0.0',ORIGINS=(process.env.ALLOWED_ORIGINS||'').split(',').map(x=>x.trim()).filter(Boolean),NPK=()=>process.env.NOVA_POSHTA_API_KEY,UPT=()=>process.env.UKRPOSHTA_BEARER;
const cache=new Map();const cached=async(k,fn,ttl=600000)=>{const c=cache.get(k);if(c&&c.t>Date.now())return c.v;const v=await fn();cache.set(k,{v,t:Date.now()+ttl});return v};
class ApiErr extends Error{constructor(m,s=502){super(m);this.s=s}}
async function np(model,method,props){
 if(!NPK())throw new ApiErr('Не налаштовано ключ Нової пошти (NOVA_POSHTA_API_KEY).',503);
 const r=await fetch('https://api.novaposhta.ua/v2.0/json/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({apiKey:NPK(),modelName:model,calledMethod:method,methodProperties:props})});
 const j=await r.json();if(!j.success)throw new ApiErr('Нова пошта: '+((j.errors||[]).join('; ')||'помилка API'));return j.data}
async function up(p,params){
 if(!UPT())throw new ApiErr('Не налаштовано токен Укрпошти (UKRPOSHTA_BEARER).',503);
 const u=new URL('https://www.ukrposhta.ua/address-classifier-ws/'+p);for(const k in params)u.searchParams.set(k,params[k]);
 const r=await fetch(u,{headers:{Authorization:'Bearer '+UPT(),Accept:'application/json'}});
 if(!r.ok)throw new ApiErr('Укрпошта: помилка API (HTTP '+r.status+')');
 const j=await r.json(),e=j&&j.Entries&&j.Entries.Entry;return e?(Array.isArray(e)?e:[e]):[]}
const H={
 '/api/status':async()=>({np:!!NPK(),up:!!UPT()}),
 async '/api/np/cities'(q){if(q.q.length<2)return[];
  const d=await np('Address','searchSettlements',{CityName:q.q,Limit:15,Page:1});
  return((d[0]&&d[0].Addresses)||[]).filter(a=>a.DeliveryCity&&+a.Warehouses!==0).map(a=>({id:a.DeliveryCity,name:a.MainDescription||a.Present,sub:[a.Area&&a.Area+' обл.',a.Region&&a.Region+' р-н'].filter(Boolean).join(', ')}))},
 async '/api/np/warehouses'(q){if(!q.city)throw new ApiErr('Не вказано місто',400);
  const all=await cached('npw'+q.city,async()=>{let out=[];for(let p=1;p<=6;p++){const d=await np('AddressGeneral','getWarehouses',{CityRef:q.city,Limit:500,Page:p,Language:'UA'});out=out.concat(d);if(d.length<500)break}return out});
  const isP=w=>w.CategoryOfWarehouse==='Postomat'||/поштомат/i.test(w.TypeOfWarehouseDescription||w.Description||'');
  return all.filter(w=>q.type==='postomat'?isP(w):!isP(w)).map(w=>({id:w.Ref,num:w.Number,name:w.Description,addr:w.ShortAddress||w.Description,type:q.type==='postomat'?'Поштомат':'Відділення'}))},
 async '/api/up/cities'(q){if(q.q.length<2)return[];
  const d=await cached('upc'+q.q.toLowerCase(),()=>up('get_city_by_region_id_and_district_id_and_city_ua',{city_ua:q.q}),300000);
  return d.slice(0,20).map(c=>({id:c.CITY_ID,name:[c.SHORTCITYTYPE_UA,c.CITY_UA].filter(Boolean).join(' '),sub:[c.REGION_UA,c.DISTRICT_UA].filter(Boolean).join(', ')}))},
 async '/api/up/offices'(q){if(!q.city)throw new ApiErr('Не вказано місто',400);
  const d=await cached('upo'+q.city,()=>up('get_postoffices_by_postcode_cityid_cityvpzid',{city_id:q.city}));
  return d.map(o=>({id:o.POSTCODE||o.POSTINDEX,num:o.POSTINDEX||o.POSTCODE,name:o.PO_LONG||o.PO_SHORT||'Відділення',addr:[o.STREET_UA_VPZ,o.HOUSENUMBER].filter(Boolean).join(', ')||o.PO_LONG||'',type:o.TYPE_LONG||'Відділення'}))}};
const MIME={'.html':'text/html','.css':'text/css','.js':'text/javascript','.png':'image/png','.jpg':'image/jpeg'};
const cors=o=>ORIGINS.includes('*')?{'Access-Control-Allow-Origin':'*'}:(o&&ORIGINS.includes(o)?{'Access-Control-Allow-Origin':o,'Vary':'Origin'}:{});
http.createServer(async(req,res)=>{const u=new URL(req.url,'http://x'),co=cors(req.headers.origin);const send=(c,b,t='application/json')=>{res.writeHead(c,{'Content-Type':t+'; charset=utf-8',...(u.pathname.startsWith('/api/')?co:{})});res.end(b)};
 if(req.method==='OPTIONS'&&u.pathname.startsWith('/api/')){res.writeHead(204,{...co,'Access-Control-Allow-Methods':'GET,OPTIONS','Access-Control-Allow-Headers':'Content-Type','Access-Control-Max-Age':'86400'});return res.end()}
 if(u.pathname.startsWith('/api/')){const h=H[u.pathname];if(!h)return send(404,'{"error":"Не знайдено"}');
  try{const q=Object.fromEntries(u.searchParams);q.q=(q.q||'').trim();send(200,JSON.stringify({data:await h(q)}))}catch(e){send(e.s||502,JSON.stringify({error:e.s?e.message:'Сервіс доставки недоступний, спробуйте пізніше.'}))}return}
 let p=u.pathname==='/'?'/index.html':decodeURIComponent(u.pathname);
 if(!/^\/(index\.html|admin\.html|(css|js|assets)\/[\w.\-]+)$/.test(p))return send(404,'Not found','text/plain');
 fs.readFile(path.join(__dirname,p),(e,b)=>e?send(404,'Not found','text/plain'):(res.writeHead(200,{'Content-Type':(MIME[path.extname(p)]||'application/octet-stream')}),res.end(b)))
}).listen(PORT,HOST,()=>{console.log('Сервер запущено на порту '+PORT+' | НП ключ: '+(NPK()?'є':'НЕМАЄ')+' | Укрпошта токен: '+(UPT()?'є':'НЕМАЄ'));
 console.log('З цього комп’ютера: http://localhost:'+PORT);
 for(const l of Object.values(require('os').networkInterfaces()))for(const a of l)if(a.family==='IPv4'&&!a.internal)console.log('З телефону в тій самій Wi-Fi: http://'+a.address+':'+PORT)});
