/* Pixel office simulation + 3 renderers (side / top-down 3/4 / isometric). World: x 0..320, depth y 0..60 */
(function(){
const STATUS={working:'#2ee6cf',planning:'#7b8cff',review:'#c084fc',waiting:'#f5b34a',blocked:'#f87171',done:'#4ade80',paused:'#8a929e',idle:'#5b6472'};
const HEAD_S=['...hhhhh..','..hhhhhhh.','..hhsssss.','..hhsses..','..hhsssss.','...hsss...','....ss....'];
const TORSO_S=['...cccc...','..cccccc..','..dcccss..','..dcccc...','..dcccc...'];
const LEGS_ST=['...pppp...','...pppp...','...pp.pp..','...pp.pp..','...pp.pp..','...pp.pp..','..kkk.kkk.'];
const LEGS_WK=['...pppp...','...pppp...','..ppp.pp..','..pp...pp.','.pp.....pp','.pp.....pp','kkk....kkk'];
const SIT_BODY=['...cccc...','..cccccc..','..dccccsss','..dcccc...','..dpppppp.','...pppppp.','......ppp.','......ppp.','......ppp.','.....kkkk.'];
const SIT_BODY2=['...cccc...','..cccccc..','..dccccs..','..dcccc.ss','..dpppppp.','...pppppp.','......ppp.','......ppp.','......ppp.','.....kkkk.'];
const HEAD_F=['...hhhh...','..hhhhhh..','..hhhhhh..','..hsesesh.','..hssssh..','...ssss...','....ss....'];
const HEAD_B=['...hhhh...','..hhhhhh..','..hhhhhh..','..hhhhhh..','..hhhhhh..','...hhhh...','....ss....'];
const TORSO_F=['...cccc...','..sccccs..','..sccccs..','..dccccd..','..dccccd..'];
const LEGS_WKF=['...pppp...','...pppp...','...pp.pp..','...pp.pp..','...pp.....','...pp.....','..kkk.kkk.'];
const SPR={
  side_stand:HEAD_S.concat(TORSO_S,LEGS_ST), side_walk:HEAD_S.concat(TORSO_S,LEGS_WK),
  sit:HEAD_S.concat(SIT_BODY), sit2:HEAD_S.concat(SIT_BODY2),
  front_stand:HEAD_F.concat(TORSO_F,LEGS_ST), front_walk:HEAD_F.concat(TORSO_F,LEGS_WKF),
  back_stand:HEAD_B.concat(TORSO_F,LEGS_ST), back_walk:HEAD_B.concat(TORSO_F,LEGS_WKF),
};
const HAIR=['#3a2418','#14151b','#c9903a','#6b3a2a','#e8e0d0','#8a3b2a'];
const AGENT_COLORS=['#2ee6cf','#7b8cff','#c084fc','#f5b34a','#4ade80','#fb7185'];
function shade(hex,f){const n=parseInt(hex.slice(1),16);const r=Math.max(0,Math.min(255,((n>>16)&255)*f)),g=Math.max(0,Math.min(255,((n>>8)&255)*f)),b=Math.max(0,Math.min(255,(n&255)*f));return '#'+[r,g,b].map(v=>Math.round(v).toString(16).padStart(2,'0')).join('')}
function pal(a){return {h:a.hair,s:'#f1c9a5',e:'#1a1c24',k:'#22242e',p:'#2b3350',c:a.color,d:shade(a.color,.65),w:'#fff'}}
function spr(ctx,rows,p,x,y,flip){x=Math.round(x);y=Math.round(y);const w=rows[0].length;for(let r=0;r<rows.length;r++){const row=rows[r];for(let c=0;c<w;c++){const ch=row[flip?w-1-c:c];if(ch!=='.'&&p[ch]){ctx.fillStyle=p[ch];ctx.fillRect(x+c,y+r,1,1)}}}}
function rect(ctx,x,y,w,h,col){ctx.fillStyle=col;ctx.fillRect(Math.round(x),Math.round(y),Math.round(w),Math.round(h))}
function rnd(seed){let s=seed;return()=>{s=(s*9301+49297)%233280;return s/233280}}
const TASKS=['Rate limiter for /api','Fix flaky auth test','Add SSE heartbeat','Migrate budget column','Refactor merge queue','Verify cmd timeout','Pause checkpoint UI','Orphan run sweep','Plan graph cycles','Prisma seed cleanup','Token cost report','Retry cap on review'];
const NAMES=[['Ada','developer'],['Linus','developer'],['Grace','qa'],['Hopper','developer'],['Dijkstra','manager'],['Turing','developer']];

class World{
  constructor(cfg){
    const legacy=!(cfg&&cfg.departments);const n=legacy?(cfg||5):0;
    const depts=legacy?[{name:'Engineering',color:'#2ee6cf',agents:NAMES.slice(0,n).map((nm,i)=>({name:nm[0],role:nm[1],color:AGENT_COLORS[i]}))}]:cfg.departments;
    this.legacy=legacy;this.t=0;this.events=[];this.seq=0;this.nextTaskAt=1;this.taskId=100;
    this.board={todo:[],doing:[],review:[],done:[]};
    this.departments=depts.map((d,i)=>({name:d.name,color:d.color,index:i}));
    this.desks=[];this.agents=[];let x=legacy?96:110;const step=legacy?42:40;
    depts.forEach((d,di)=>{const x0=x;d.agents.forEach(ag=>{const idx=this.desks.length;this.desks.push({x,y:30,dept:di});
      this.agents.push({id:'a'+idx,name:ag.name,role:ag.role,color:ag.color||d.color,dept:di,hair:HAIR[idx%HAIR.length],x:x-13,y:30,deskIdx:idx,state:'sit',dir:1,path:[],timer:1+idx*1.1,task:null,progress:0,frame:0,sw:0});x+=step});
      this.departments[di].x0=x0-6;this.departments[di].x1=x-step+30;x+=legacy?0:30});
    this.W=legacy?320:Math.max(320,x+30);this.boardPos={x:34,y:6};this.coffeePos={x:this.W-26,y:22};
    for(let i=0;i<Math.max(3,Math.ceil(this.agents.length*.6));i++)this.spawnTask();
  }
  ev(type,a,task,text){this.events.unshift({seq:++this.seq,t:this.t,type,agent:a?a.name:'system',agentColor:a?a.color:'#8a929e',task:task?task.key:'',text});if(this.events.length>80)this.events.pop()}
  spawnTask(){const d=this.departments[Math.floor(Math.random()*this.departments.length)];const t={key:'T-'+(this.taskId++),title:TASKS[this.taskId%TASKS.length],color:null,deptColor:this.legacy?null:d.color,dept:d.index,status:'todo',blockedBy:null};
    if(!this.legacy&&Math.random()<.45){const pool=this.board.todo.concat(this.board.doing).filter(x=>x.dept!==t.dept);if(pool.length)t.blockedBy=pool[Math.floor(Math.random()*pool.length)]}this.board.todo.push(t);this.ev('task.created',null,t,t.title)}
  ready(t){return !t.blockedBy||t.blockedBy.status==='done'}
  boardTarget(){return{x:this.boardPos.x-5,y:10}}
  coffeeTarget(){return{x:this.coffeePos.x-14,y:this.coffeePos.y}}
  seat(a){const d=this.desks[a.deskIdx];return{x:d.x-13,y:d.y}}
  goTo(a,target,next){a.path=[{x:a.x,y:48},{x:target.x,y:48},{x:target.x,y:target.y}];a.state='walk';a.next=next}
  pause(id){const a=this.agents.find(x=>x.id===id);if(!a||a.state!=='work')return;a.state='pausing';a.timer=1.3;this.ev('run.pause_requested',a,a.task,'draining current step')}
  resume(id){const a=this.agents.find(x=>x.id===id);if(!a||a.state!=='paused')return;a.state='resuming';a.timer=.9;this.ev('run.resume_requested',a,a.task,'from checkpoint')}
  stop(id){const a=this.agents.find(x=>x.id===id);if(!a||!a.task)return;const t=a.task;this.ev('run.stopped',a,t,'cancelled by operator');this.board.doing=this.board.doing.filter(x=>x!==t);t.status='todo';t.color=null;this.board.todo.push(t);a.task=null;a.progress=0;if(a.state==='work'||a.state==='paused'||a.state==='blocked'||a.state==='pausing'||a.state==='resuming'){const s=this.seat(a);a.x=s.x;a.y=s.y;a.state='sit';a.timer=2}}
  status(a){return({sit:'idle',walk:a.task?(a.progress>=100?'review':'planning'):'idle',grab:'planning',work:'working',pausing:'paused',paused:'paused',resuming:'planning',blocked:'blocked',coffee:'idle',arcade:'idle',deliver:'review'})[a.state]||'idle'}
  tick(dt){
    this.t+=dt;const T=this.t;
    this.nextTaskAt-=dt;if(this.nextTaskAt<=0&&this.board.todo.length<Math.max(4,this.agents.length)){this.spawnTask();this.nextTaskAt=(6+Math.random()*8)*5/this.agents.length}
    // review→done
    this.board.review.forEach(t=>{t.rt-=dt;if(t.rt<=0){this.board.review=this.board.review.filter(x=>x!==t);t.status='done';this.board.done.push(t);if(this.board.done.length>6)this.board.done.shift();this.ev('task.done',null,t,'merged --no-ff')}});
    for(const a of this.agents){
      a.timer-=dt;a.sw+=dt;
      switch(a.state){
        case 'sit':if(a.timer<=0){const ti=this.board.todo.findIndex(t=>t.dept===a.dept&&this.ready(t));if(ti>=0){const t=this.board.todo.splice(ti,1)[0];t.color=a.color;t.status='doing';this.board.doing.push(t);a.task=t;this.ev('task.assigned',a,t,'picked from board');this.goTo(a,this.boardTarget(),'grab')}else{const r=Math.random();if(r<.18&&this.arcadePos)this.goTo(a,this.arcadeTarget(),'arcade');else if(r<.4)this.goTo(a,this.coffeeTarget(),'coffee');else a.timer=2+Math.random()*3}}break;
        case 'walk':{const p=a.path[0];if(!p){a.state=a.next;a.timer=a.next==='grab'?1.4:a.next==='coffee'?3.5:a.next==='arcade'?5:0;if(a.next==='work'){this.ev('run.started',a,a.task,'worktree '+a.task.key.toLowerCase())}if(a.next==='deliver'){a.state='grab';a.timer=1.2;a.delivering=true}break}
          const dx=p.x-a.x,dy=p.y-a.y,d=Math.hypot(dx,dy),sp=38*dt;if(d<=sp){a.x=p.x;a.y=p.y;a.path.shift()}else{a.x+=dx/d*sp;a.y+=dy/d*sp}if(Math.abs(dx)>.5)a.dir=dx>0?1:-1;a.vdir=Math.abs(dy)>Math.abs(dx)?(dy>0?'front':'back'):'side';break}
        case 'grab':if(a.timer<=0){if(a.delivering){a.delivering=false;const t=a.task;this.board.doing=this.board.doing.filter(x=>x!==t);t.status='review';t.rt=4+Math.random()*4;this.board.review.push(t);this.ev('task.review',a,t,'diff handed to QA');a.task=null;a.progress=0;this.goTo(a,this.seat(a),'sit');a.timer=1.5}else{a.progress=0;this.goTo(a,this.seat(a),'work')}}break;
        case 'work':a.progress+=dt*(5+Math.random()*4);if(Math.random()<dt*.02){this.ev('run.tool_call',a,a.task,['Edit','Bash npm test','Read','Grep'][Math.floor(Math.random()*4)])}if(Math.random()<dt*.025&&a.progress<90){a.state='blocked';a.timer=4;this.ev('task.blocked',a,a.task,'verify failed · attempt 2')}else if(a.progress>=100){a.progress=100;this.ev('run.succeeded',a,a.task,'verify passed');this.goTo(a,this.boardTarget(),'deliver')}break;
        case 'blocked':if(a.timer<=0){a.state='work';this.ev('task.rework',a,a.task,'retrying with fix')}break;
        case 'pausing':if(a.timer<=0){a.state='paused';this.ev('run.paused',a,a.task,'checkpoint created')}break;
        case 'resuming':if(a.timer<=0){a.state='work';this.ev('run.resumed',a,a.task,'same worktree')}break;
        case 'coffee':case 'arcade':if(a.timer<=0){this.goTo(a,this.seat(a),'sit');a.timer=3}break;
        case 'paused':break;
      }
    }
  }
}

/* ---------- shared drawing bits ---------- */
function stars(ctx,x,y,w,h,seed,t){const r=rnd(seed);for(let i=0;i<18;i++){const sx=x+Math.floor(r()*w),sy=y+Math.floor(r()*h);const tw=(Math.sin(t*2+i)*.5+.5)>.6;rect(ctx,sx,sy,1,1,tw?'#ffffff':'#7d86a8')}}
function drawBoard(ctx,world,x,y,w,h){ // wall-mounted task board in plane coords
  rect(ctx,x-1,y-1,w+2,h+2,'#0a0c12');rect(ctx,x,y,w,h,'#12171f');rect(ctx,x,y,w,6,'#1c2532');
  const cols=['todo','doing','review','done'],cw=(w-2)/4;
  cols.forEach((c,i)=>{const cx=x+1+i*cw;rect(ctx,cx,y+6,cw-1,h-7,i%2?'#10141b':'#131820');rect(ctx,cx+1,y+2,cw-3,2,[STATUS.idle,STATUS.working,STATUS.review,STATUS.done][i]);
    world.board[c].slice(0,Math.max(1,Math.floor((h-10)/7))).forEach((t,j)=>{const col=t.color||t.deptColor||'#5b6472';rect(ctx,cx+2,y+9+j*7,cw-5,5,col);rect(ctx,cx+3,y+10+j*7,cw-7,1,shade(col,1.5));rect(ctx,cx+3,y+12+j*7,cw-8,1,shade(col,.6));if(t.blockedBy&&t.blockedBy.status!=='done')rect(ctx,cx+cw-5,y+10+j*7,2,3,'#f5b34a')})});
}
function bubble(ctx,a,x,y){const s=a.state;if(s==='blocked'){rect(ctx,x-1,y-1,7,8,'#f87171');rect(ctx,x,y,5,6,'#2a0f12');rect(ctx,x+2,y+1,1,3,'#f87171');rect(ctx,x+2,y+5,1,1,'#f87171')}
  else if(s==='paused'||s==='pausing'){const p=Math.floor(a.sw*2)%3;for(let i=0;i<=p;i++)rect(ctx,x+i*3,y-i*3,2,2,'#8a929e')}
  else if(s==='coffee'){rect(ctx,x,y,4,4,'#f1c9a5');rect(ctx,x+4,y+1,1,2,'#f1c9a5');const k=Math.floor(a.sw*4)%2;rect(ctx,x+1+k,y-3,1,2,'#c8cfda');rect(ctx,x+2-k,y-2,1,1,'#c8cfda')}
  else if(s==='arcade'){const k=Math.floor(a.sw*6)%2;rect(ctx,x+k,y,2,2,'#f5b34a');rect(ctx,x+3-k,y-3,2,2,'#2ee6cf')}
  else if(s==='grab'){rect(ctx,x,y,5,4,a.task?a.task.color:'#fff');rect(ctx,x+1,y+1,3,1,'#fff')}
  else if(s==='work'||s==='resuming'){rect(ctx,x-4,y+1,12,3,'#0a0c12');rect(ctx,x-3,y+2,Math.max(1,Math.round(a.progress/10)),1,STATUS.working)}}
function labels(ctx,S,items){ctx.setTransform(1,0,0,1,0,0);ctx.font='9px Silkscreen, monospace';ctx.textAlign='center';for(const it of items){const w=ctx.measureText(it.text).width+8;ctx.fillStyle='rgba(8,9,12,.85)';ctx.fillRect(it.x*S-w/2,it.y*S-11,w,13);ctx.fillStyle=it.color||'#c8cfda';ctx.fillText(it.text,it.x*S,it.y*S-1)}}
function screenLines(ctx,x,y,w,h,status,t,seed){const on=status!=='paused'&&status!=='idle';rect(ctx,x,y,w,h,on?'#0b1f24':'#0a0c10');if(!on)return;const r=rnd(seed+Math.floor(t*3));for(let i=0;i<h-1;i++){const lw=1+Math.floor(r()*(w-2));rect(ctx,x+1,y+1+i,lw,1,i%3===0?STATUS[status]||STATUS.working:'#1f5f66')}}

/* ---------- SIDE VIEW ---------- */
function renderSide(ctx,world,S){
  const W=world.W||320,H=150,t=world.t;ctx.setTransform(S,0,0,S,0,0);ctx.clearRect(0,0,W,H);const tags=[];
  rect(ctx,0,0,W,96,'#1b2030');for(let x=0;x<W;x+=32)rect(ctx,x,0,1,96,'#171b29');rect(ctx,0,0,W,3,'#12151f');
  rect(ctx,0,93,W,3,'#0e1016');rect(ctx,0,96,W,54,'#252938');
  for(let y=96;y<H;y+=9){rect(ctx,0,y,W,1,'#1f2331');const off=((y-96)/9)%2?24:0;for(let x=off;x<W;x+=48)rect(ctx,x,y,1,9,'#1f2331')}
  // window
  const win=o=>{rect(ctx,o+196,10,70,54,'#0d1018');rect(ctx,o+199,13,64,48,'#0a0f1f');stars(ctx,o+199,13,64,30,7+o,t);if(!o){rect(ctx,244,18,8,8,'#f5efd0');rect(ctx,246,17,4,1,'#f5efd0');rect(ctx,246,26,4,1,'#f5efd0');rect(ctx,243,20,1,4,'#f5efd0');rect(ctx,252,20,1,4,'#f5efd0')}
  [[200,40,10,21],[212,46,8,15],[222,36,12,25],[236,48,9,13],[247,42,11,19],[259,50,4,11]].forEach(b=>{rect(ctx,o+b[0],b[1],b[2],b[3],'#111626');const r=rnd(b[0]+o);for(let i=0;i<6;i++)rect(ctx,o+b[0]+1+Math.floor(r()*(b[2]-2)),b[1]+2+Math.floor(r()*(b[3]-3)),1,1,r()>.5?'#f5b34a':'#2ee6cf')});
  rect(ctx,o+230,13,2,48,'#0d1018');rect(ctx,o+199,36,64,2,'#0d1018')};for(let wx=0;wx<W-270;wx+=300)win(wx);
  if(!world.legacy)world.departments.forEach((d,i)=>{const w=d.x1-d.x0;rect(ctx,d.x0+4,70,w-8,12,'#0d1018');rect(ctx,d.x0+5,71,w-10,10,'#12171f');rect(ctx,d.x0+6,80,w-12,1,d.color);tags.push({x:(d.x0+d.x1)/2,y:80,text:d.name.toUpperCase(),color:d.color});
    if(i>0){const gx=d.x0-15;rect(ctx,gx-1,44,3,52,'#0d1018');rect(ctx,gx,45,1,50,'rgba(46,230,207,.22)');rect(ctx,gx-6,93,13,3,'#0d1018')}});
  drawBoard(ctx,world,14,14,72,54);
  // clock + poster
  rect(ctx,120,22,12,12,'#0d1018');rect(ctx,121,23,10,10,'#e7eaf0');rect(ctx,126,24,1,5,'#1a1c24');rect(ctx,126,28,3,1,'#1a1c24');
  rect(ctx,140,20,22,30,'#0d1018');rect(ctx,141,21,20,28,'#1d2a3a');rect(ctx,144,26,14,3,'#2ee6cf');rect(ctx,144,32,10,2,'#c8cfda');rect(ctx,144,36,14,2,'#c8cfda');rect(ctx,144,40,7,2,'#c8cfda');
  // plants
  const plant=(x,fy)=>{rect(ctx,x,fy-8,10,8,'#3d2f27');rect(ctx,x+1,fy-9,8,1,'#5a4436');const sway=Math.round(Math.sin(t*1.5+x));rect(ctx,x+4,fy-18,2,10,'#2f7d4a');rect(ctx,x+1+sway,fy-22,4,6,'#3fa35f');rect(ctx,x+6-sway,fy-24,4,7,'#3fa35f');rect(ctx,x+3,fy-27,4,5,'#56c47a')};plant(2,134);plant(276,124);
  // coffee machine
  const c=world.coffeePos,cfy=108+c.y*.6;rect(ctx,c.x,cfy-24,18,24,'#0d1018');rect(ctx,c.x+1,cfy-23,16,22,'#2a3040');rect(ctx,c.x+3,cfy-21,12,5,'#0b1f24');rect(ctx,c.x+4,cfy-20,Math.floor(t*4)%10,1,'#2ee6cf');rect(ctx,c.x+6,cfy-9,6,4,'#e7eaf0');rect(ctx,c.x+7+Math.floor(t*3)%2,cfy-13,1,3,'#8a929e');rect(ctx,c.x+3,cfy-4,12,1,'#5a4436');
  // desks with seated agents
  world.desks.forEach((d,i)=>{const fy=108+d.y*.6,a=world.agents[i],seated=a&&['sit','work','paused','pausing','resuming','blocked'].includes(a.state);
    rect(ctx,d.x-14,fy-19,2,11,'#0d1018');rect(ctx,d.x-15,fy-20,6,3,'#0d1018');rect(ctx,d.x-14,fy-8,10,3,'#20242f');rect(ctx,d.x-10,fy-5,2,4,'#0d1018');rect(ctx,d.x-14,fy-1,10,1,'#0d1018');
    if(seated&&a.state!=='blocked'){const frame=a.state==='work'?(Math.floor(t*8)%2?'sit':'sit2'):'sit';spr(ctx,SPR[frame],pal(a),d.x-13,fy-17,false);bubble(ctx,a,d.x-9,fy-24)}
    rect(ctx,d.x-2,fy-15,30,3,'#5a4436');rect(ctx,d.x-2,fy-12,30,1,'#3d2f27');rect(ctx,d.x-1,fy-11,2,11,'#3d2f27');rect(ctx,d.x+25,fy-11,2,11,'#3d2f27');
    rect(ctx,d.x+1,fy-17,7,2,'#20242f');rect(ctx,d.x+10,fy-28,13,11,'#0d1018');screenLines(ctx,d.x+11,fy-27,11,9,a?world.status(a):'idle',t,i*13);rect(ctx,d.x+15,fy-17,3,2,'#0d1018');
    if(seated&&a.state==='blocked'){spr(ctx,SPR.side_stand,pal(a),d.x-12,fy-19+3,false);bubble(ctx,a,d.x-8,fy-27)}
    if(a&&seated)tags.push({x:d.x+7,y:fy+12,text:a.name,color:a.color})});
  // walking agents
  world.agents.filter(a=>['walk','grab','coffee'].includes(a.state)).sort((p,q)=>p.y-q.y).forEach(a=>{const fy=108+a.y*.6;let rows;const walking=a.state==='walk',f=Math.floor(t*7)%2;
    if(walking&&a.vdir==='front')rows=f?SPR.front_walk:SPR.front_stand;else if(walking&&a.vdir==='back')rows=f?SPR.back_walk:SPR.back_stand;else rows=walking?(f?SPR.side_walk:SPR.side_stand):SPR.side_stand;
    const flip=a.dir<0;spr(ctx,rows,pal(a),a.x,fy-19-(walking&&f?0:0),flip);if(a.task&&(a.state==='walk'||a.state==='grab')){rect(ctx,a.x+(flip?-1:7),fy-9,4,3,a.task.color)}bubble(ctx,a,a.x+3,fy-27);tags.push({x:a.x+5,y:fy+12,text:a.name,color:a.color})});
  labels(ctx,S,tags.concat([{x:50,y:14,text:'BOARD',color:'#2ee6cf'},{x:world.coffeePos.x+9,y:100,text:'COFFEE',color:'#8a929e'}]));
}

/* ---------- TOP-DOWN 3/4 ---------- */
function renderTop(ctx,world,S){
  const W=320,H=130,t=world.t;ctx.setTransform(S,0,0,S,0,0);ctx.clearRect(0,0,W,H);const sy=y=>30+y*1.6;
  rect(ctx,0,0,W,28,'#1b2030');for(let x=0;x<W;x+=32)rect(ctx,x,0,1,28,'#171b29');rect(ctx,0,26,W,2,'#0e1016');
  rect(ctx,0,28,W,H-28,'#2a2e3d');for(let y=28;y<H;y+=12)for(let x=0;x<W;x+=12)if(((x/12)+(y/12))%2===0)rect(ctx,x,y,12,12,'#262a38');
  rect(ctx,0,28,W,1,'#1f2331');rect(ctx,0,H-2,W,2,'#0e1016');
  drawBoard(ctx,world,14,3,72,22);
  rect(ctx,196,4,70,20,'#0d1018');rect(ctx,199,6,64,15,'#0a0f1f');stars(ctx,199,6,64,12,7,t);rect(ctx,230,6,2,15,'#0d1018');rect(ctx,250,8,5,5,'#f5efd0');
  rect(ctx,120,8,12,12,'#0d1018');rect(ctx,121,9,10,10,'#e7eaf0');rect(ctx,126,10,1,5,'#1a1c24');
  // rug
  rect(ctx,30,sy(44),100,26,'#3a2b3f');rect(ctx,32,sy(44)+2,96,22,'#2f2436');rect(ctx,34,sy(44)+4,92,18,'#3a2b3f');
  const c=world.coffeePos;rect(ctx,c.x,sy(c.y)-14,18,14,'#0d1018');rect(ctx,c.x+1,sy(c.y)-13,16,12,'#2a3040');rect(ctx,c.x+6,sy(c.y)-9,6,4,'#e7eaf0');rect(ctx,c.x+3,sy(c.y)-12,12,2,'#2ee6cf');
  const plant=(x,y)=>{rect(ctx,x,y,10,10,'#3d2f27');rect(ctx,x+1,y+1,8,8,'#2f7d4a');rect(ctx,x+3,y+3,4,4,'#56c47a');rect(ctx,x+2,y+6,2,2,'#3fa35f')};plant(3,sy(34));plant(276,sy(26));plant(3,sy(58));
  const draw=[];
  world.desks.forEach((d,i)=>{const a=world.agents[i],y=sy(d.y),seated=a&&['sit','work','paused','pausing','resuming','blocked'].includes(a.state);
    draw.push({z:y,f:()=>{rect(ctx,d.x-2,y-14,30,14,'#5a4436');rect(ctx,d.x-2,y-1,30,1,'#3d2f27');rect(ctx,d.x-2,y-14,30,1,'#6e5443');rect(ctx,d.x+9,y-13,13,5,'#0d1018');screenLines(ctx,d.x+10,y-12,11,3,a?world.status(a):'idle',t,i*13);rect(ctx,d.x+11,y-6,9,3,'#20242f');rect(ctx,d.x+1,y-5,5,3,'#e7eaf0');
      rect(ctx,d.x+9,y+1,12,8,'#20242f');rect(ctx,d.x+10,y+7,10,3,'#0d1018')}});
    if(seated)draw.push({z:y+1,f:()=>{const rows=a.state==='blocked'?SPR.front_stand:SPR.back_stand;spr(ctx,rows,pal(a),d.x+10,y-10+(a.state==='blocked'?6:0),false);bubble(ctx,a,d.x+14,y-16)}});});
  world.agents.filter(a=>['walk','grab','coffee'].includes(a.state)).forEach(a=>{const y=sy(a.y);draw.push({z:y+19,f:()=>{const walking=a.state==='walk',f=Math.floor(t*7)%2;let rows;
    if(walking&&a.vdir==='front')rows=f?SPR.front_walk:SPR.front_stand;else if(walking&&a.vdir==='back')rows=f?SPR.back_walk:SPR.back_stand;else if(a.state==='grab')rows=SPR.back_stand;else rows=walking?(f?SPR.side_walk:SPR.side_stand):SPR.side_stand;
    spr(ctx,rows,pal(a),a.x,y-19,a.dir<0);if(a.task&&(a.state==='walk'||a.state==='grab'))rect(ctx,a.x+(a.dir<0?-1:7),y-9,4,3,a.task.color);bubble(ctx,a,a.x+3,y-27)}})});
  draw.sort((p,q)=>p.z-q.z).forEach(d=>d.f());
  labels(ctx,S,world.agents.map(a=>{const seated=!['walk','grab','coffee'].includes(a.state),d=world.desks[a.deskIdx];return{x:seated?d.x+15:a.x+5,y:(seated?sy(d.y)+8:sy(a.y))+12,text:a.name,color:a.color}}).concat([{x:50,y:3,text:'BOARD',color:'#2ee6cf'}]));
}

/* ---------- ISOMETRIC ---------- */
function renderIso(ctx,world,S){
  const W=world.W||320,t=world.t,ky=1.45,kx=world.legacy?.6:Math.min(.6,300/W);let OX=98,OY=34,H=170;
  if(!world.legacy){OX=64*ky+12;const Wc=Math.round(W*kx+64*ky+24);H=Math.round((W*kx+64*ky)*.5+72);if(ctx.canvas.width!==Wc*S||ctx.canvas.height!==H*S){ctx.canvas.width=Wc*S;ctx.canvas.height=H*S}}
  ctx.setTransform(S,0,0,S,0,0);ctx.clearRect(0,0,ctx.canvas.width,ctx.canvas.height);
  const P=(x,y)=>[OX+x*kx-y*ky,OY+(x*kx+y*ky)*.5];const tags=[];
  const poly=(pts,col)=>{ctx.fillStyle=col;ctx.beginPath();pts.forEach((p,i)=>i?ctx.lineTo(p[0],p[1]):ctx.moveTo(p[0],p[1]));ctx.closePath();ctx.fill()};
  // walls
  const wallH=46;const A=P(0,0),B=P(W,0),C=P(0,64),D=P(W,64);
  poly([[A[0],A[1]-wallH],[B[0],B[1]-wallH],B,A],'#1b2030');poly([[A[0],A[1]-wallH],[C[0],C[1]-wallH],C,A],'#151a27');
  poly([[A[0],A[1]-wallH-2],[B[0],B[1]-wallH-2],[B[0],B[1]-wallH],[A[0],A[1]-wallH]],'#0e1016');
  // floor tiles
  for(let i=0;i<W/16;i++)for(let j=0;j<4;j++){const x=i*16,y=j*16;poly([P(x,y),P(x+16,y),P(x+16,y+16),P(x,y+16)],(i+j)%2?'#262a38':'#2a2e3d')}
  poly([A,B,D,C].map(p=>p),'rgba(0,0,0,0)');
  // back wall content via shear transform: wall plane coords (x along wall 0..320, y up)
  const wallTx=(fn)=>{ctx.save();ctx.setTransform(S*kx,S*kx*.5,0,S,A[0]*S,(A[1]-wallH)*S);fn();ctx.restore()};
  wallTx(()=>{drawBoard(ctx,world,world.legacy?10:6,6,world.legacy?100:90,36);for(let o=0;o<W-300;o+=300){rect(ctx,o+200,4,100,34,'#0d1018');rect(ctx,o+204,6,92,29,'#0a0f1f');stars(ctx,o+204,6,92,20,7+o,t);rect(ctx,o+249,6,3,29,'#0d1018');rect(ctx,o+204,22,92,1,'#0d1018');if(!o)rect(ctx,270,10,8,6,'#f5efd0')}
    if(!world.legacy)world.departments.forEach(d=>{const w=d.x1-d.x0;rect(ctx,d.x0+4,38,w-8,7,'#0d1018');rect(ctx,d.x0+5,39,w-10,5,'#12171f');rect(ctx,d.x0+6,43,w-12,1,d.color);const wx=(d.x0+d.x1)/2;tags.push({x:A[0]+wx*kx,y:A[1]-wallH+wx*kx*.5+49,text:d.name.toUpperCase(),color:d.color})});rect(ctx,130,12,16,12,'#0d1018');rect(ctx,132,13,12,10,'#e7eaf0');rect(ctx,138,14,2,5,'#1a1c24');rect(ctx,158,10,30,26,'#0d1018');rect(ctx,160,11,26,24,'#1d2a3a');rect(ctx,164,15,18,3,'#2ee6cf');rect(ctx,164,21,14,2,'#c8cfda');rect(ctx,164,25,18,2,'#c8cfda')});
  const box=(x,y,w,d,h,top,l,r)=>{const p1=P(x,y),p2=P(x+w,y),p3=P(x+w,y+d),p4=P(x,y+d);const up=p=>[p[0],p[1]-h];poly([up(p1),up(p2),up(p3),up(p4)],top);poly([up(p4),up(p3),p3,p4],l);poly([up(p3),up(p2),p2,p3],r)};
  const draw=[];
  // coffee
  const c=world.coffeePos;draw.push({z:c.x*kx+c.y*ky,f:()=>{box(c.x,c.y-8,16,12,22,'#3a4150','#20262f','#2a3040');const p=P(c.x+16,c.y-2);rect(ctx,p[0]-1,p[1]-18,5,4,'#0b1f24');rect(ctx,p[0]-1,p[1]-17,Math.floor(t*4)%5,1,'#2ee6cf');rect(ctx,p[0],p[1]-8,3,3,'#e7eaf0')}});
  if(!world.legacy)world.departments.forEach((d,i)=>{if(!i)return;const gx=d.x0-15;draw.push({z:gx*kx+34*ky,f:()=>box(gx-1,22,2,26,24,'#3a4a55','#1c2a33','#24363f')})});
  const plant=(x,y)=>draw.push({z:x*kx+y*ky,f:()=>{box(x,y,8,8,6,'#5a4436','#3d2f27','#4a382e');const p=P(x+4,y+4);rect(ctx,p[0]-1,p[1]-16,2,10,'#2f7d4a');rect(ctx,p[0]-4,p[1]-20,4,6,'#3fa35f');rect(ctx,p[0]+1,p[1]-22,4,7,'#3fa35f');rect(ctx,p[0]-2,p[1]-25,4,5,'#56c47a')}});plant(4,50);plant(W-20,50);plant(4,4);
  world.desks.forEach((d,i)=>{const a=world.agents[i],seated=a&&['sit','work','paused','pausing','resuming','blocked'].includes(a.state);
    draw.push({z:d.x*kx+(d.y-4)*ky,f:()=>{box(d.x-2,d.y-8,30,10,14,'#5a4436','#3d2f27','#4a382e');const m=P(d.x+14,d.y-6);rect(ctx,m[0]-6,m[1]-27,13,11,'#0d1018');screenLines(ctx,m[0]-5,m[1]-26,11,9,a?world.status(a):'idle',t,i*13);rect(ctx,m[0]-1,m[1]-16,3,2,'#0d1018');const k=P(d.x+6,d.y-1);rect(ctx,k[0]-3,k[1]-16,7,2,'#20242f')}});
    draw.push({z:d.x*kx+(d.y+8)*ky,f:()=>{const ch=P(d.x+13,d.y+10);rect(ctx,ch[0]-5,ch[1]-8,10,3,'#20242f');rect(ctx,ch[0]-5,ch[1]-19,2,11,'#0d1018');rect(ctx,ch[0]-1,ch[1]-5,2,4,'#0d1018');rect(ctx,ch[0]-5,ch[1]-1,10,1,'#0d1018');
      if(seated){const p=P(d.x+13,d.y+8);const rows=a.state==='blocked'?SPR.side_stand:(a.state==='work'&&Math.floor(t*8)%2?SPR.sit2:SPR.sit);spr(ctx,rows,pal(a),p[0]-5,p[1]-(a.state==='blocked'?19:17),false);bubble(ctx,a,p[0]-1,p[1]-26)}}});});
  world.agents.filter(a=>['walk','grab','coffee'].includes(a.state)).forEach(a=>draw.push({z:(a.x+5)*kx+a.y*ky,f:()=>{const p=P(a.x+5,a.y);const walking=a.state==='walk',f=Math.floor(t*7)%2;let rows,flip=false;
    if(walking&&a.vdir==='front'){rows=f?SPR.side_walk:SPR.side_stand;flip=true}else if(walking&&a.vdir==='back'){rows=f?SPR.back_walk:SPR.back_stand}else{rows=walking?(f?SPR.side_walk:SPR.side_stand):SPR.side_stand;flip=a.dir<0}
    spr(ctx,rows,pal(a),p[0]-5,p[1]-19,flip);if(a.task&&(a.state==='walk'||a.state==='grab'))rect(ctx,p[0]+(flip?-6:2),p[1]-9,4,3,a.task.color);bubble(ctx,a,p[0]-2,p[1]-27)}}));
  draw.sort((p,q)=>p.z-q.z).forEach(d=>d.f());
  labels(ctx,S,tags.concat(world.agents.map(a=>{const seated=!['walk','grab','coffee'].includes(a.state),d=world.desks[a.deskIdx];const p=seated?P(d.x+13,d.y+8):P(a.x+5,a.y);return{x:p[0],y:p[1]+12,text:a.name,color:a.color}})));
}
window.OfficeEngine={World,renderSide,renderTop,renderIso,STATUS,_h:{rect,spr,SPR,pal,drawBoard,bubble,labels,screenLines,stars,rnd,shade}};
})();

/* Building layout: 3 floors, stairs, lounge (arcade, coffee, vending, sofa). Side + iso renderers. */
(function(){
const E=window.OfficeEngine,{rect,spr,SPR,pal,drawBoard,bubble,labels,screenLines,stars,rnd}=E._h;
const FL=75,CORR=55;
class WorldB extends E.World{
  constructor(cfg){super({departments:cfg.departments});this.building=true;this.W=350;this.D=225;this.floors=cfg.floors;
    this.boardPos={x:50,y:8};this.arcadePos={x:150,y:2*FL+30};this.coffeePos={x:190,y:2*FL+30};this.vendingPos={x:214,y:2*FL+30};this.sofaPos={x:262,y:2*FL+30};
    this.desks=[];this.floors.forEach((ds,f)=>{let x=f===0?120:50;ds.forEach(di=>{const d=this.departments[di];if(!d)return;d.floor=f;d.x0=x-6;
      this.agents.filter(a=>a.dept===di).forEach(a=>{a.deskIdx=this.desks.length;this.desks.push({x,y:f*FL+30,dept:di,agent:a});a.x=x-13;a.y=f*FL+30;x+=40});d.x1=x-40+30;x+=30})});
    this.departments.forEach(d=>{if(d.floor===undefined){d.floor=0;d.x0=0;d.x1=0}});
  }
  floorOf(y){return Math.max(0,Math.min(2,Math.floor(y/FL)))}
  goTo(a,target,next){const c=f=>f*FL+CORR;let f=this.floorOf(a.y);const f1=this.floorOf(target.y);const p=[{x:a.x,y:c(f)}];
    while(f!==f1){if(f1>f){p.push({x:34,y:c(f)});p.push({x:10,y:c(f+1)});f++}else{p.push({x:10,y:c(f)});p.push({x:34,y:c(f-1)});f--}}
    p.push({x:target.x,y:c(f1)});p.push({x:target.x,y:target.y});a.path=p;a.state='walk';a.next=next}
  boardTarget(){return{x:this.boardPos.x+22,y:12}}
  coffeeTarget(){return{x:this.coffeePos.x-12,y:this.coffeePos.y}}
  arcadeTarget(){return{x:this.arcadePos.x+3,y:this.arcadePos.y}}
}
const SEATED=['sit','work','paused','pausing','resuming','blocked'];
function walkRows(a,t){const f=Math.floor(t*7)%2,walking=a.state==='walk';if(walking&&a.vdir==='front')return f?SPR.front_walk:SPR.front_stand;if(walking&&a.vdir==='back')return f?SPR.back_walk:SPR.back_stand;return walking?(f?SPR.side_walk:SPR.side_stand):SPR.side_stand}
function drawDeskSide(ctx,world,d,fy,t,i){const a=d.agent,seated=a&&SEATED.includes(a.state);
  rect(ctx,d.x-14,fy-19,2,11,'#0d1018');rect(ctx,d.x-15,fy-20,6,3,'#0d1018');rect(ctx,d.x-14,fy-8,10,3,'#20242f');rect(ctx,d.x-10,fy-5,2,4,'#0d1018');rect(ctx,d.x-14,fy-1,10,1,'#0d1018');
  if(seated&&a.state!=='blocked'){const frame=a.state==='work'?(Math.floor(t*8)%2?'sit':'sit2'):'sit';spr(ctx,SPR[frame],pal(a),d.x-13,fy-17,false);bubble(ctx,a,d.x-9,fy-24)}
  rect(ctx,d.x-2,fy-15,30,3,'#5a4436');rect(ctx,d.x-2,fy-12,30,1,'#3d2f27');rect(ctx,d.x-1,fy-11,2,11,'#3d2f27');rect(ctx,d.x+25,fy-11,2,11,'#3d2f27');
  rect(ctx,d.x+1,fy-17,7,2,'#20242f');rect(ctx,d.x+10,fy-28,13,11,'#0d1018');screenLines(ctx,d.x+11,fy-27,11,9,a?world.status(a):'idle',t,i*13);rect(ctx,d.x+15,fy-17,3,2,'#0d1018');
  if(seated&&a.state==='blocked'){spr(ctx,SPR.side_stand,pal(a),d.x-12,fy-16,false);bubble(ctx,a,d.x-8,fy-27)}
  return seated}
function arcadeSide(ctx,x,fy,t){rect(ctx,x,fy-32,16,32,'#0d1018');rect(ctx,x+1,fy-31,14,30,'#2a2340');rect(ctx,x+1,fy-31,14,4,'#c084fc');rect(ctx,x+3,fy-30,2,2,'#fff');rect(ctx,x+9,fy-30,4,2,'#f5b34a');
  rect(ctx,x+3,fy-26,10,8,'#0a0c10');const r=rnd(Math.floor(t*5));for(let i=0;i<5;i++)rect(ctx,x+4+Math.floor(r()*8),fy-25+Math.floor(r()*6),1,1,['#2ee6cf','#f5b34a','#fff','#f87171'][i%4]);rect(ctx,x+4+Math.floor(t*3)%7,fy-20,2,1,'#4ade80');
  rect(ctx,x+2,fy-16,12,4,'#3a3050');rect(ctx,x+4,fy-15,1,1,'#f87171');rect(ctx,x+9,fy-15,1,1,'#2ee6cf');rect(ctx,x+11,fy-15,1,1,'#f5b34a');rect(ctx,x+5,fy-18,1,3,'#8a929e');rect(ctx,x+2,fy-11,12,10,'#1e1a30');rect(ctx,x+5,fy-8,6,3,'#c084fc')}
function coffeeSide(ctx,x,fy,t){rect(ctx,x,fy-24,18,24,'#0d1018');rect(ctx,x+1,fy-23,16,22,'#2a3040');rect(ctx,x+3,fy-21,12,5,'#0b1f24');rect(ctx,x+4,fy-20,Math.floor(t*4)%10,1,'#2ee6cf');rect(ctx,x+6,fy-9,6,4,'#e7eaf0');rect(ctx,x+7+Math.floor(t*3)%2,fy-13,1,3,'#8a929e');rect(ctx,x+3,fy-4,12,1,'#5a4436')}
function vendingSide(ctx,x,fy,t){rect(ctx,x,fy-30,14,30,'#0d1018');rect(ctx,x+1,fy-29,12,28,'#1d2a3a');rect(ctx,x+2,fy-28,7,18,'#0a0f1f');for(let r=0;r<4;r++)for(let c=0;c<3;c++)rect(ctx,x+3+c*2,fy-27+r*4,1,2,['#f87171','#f5b34a','#4ade80','#7b8cff'][(r+c)%4]);rect(ctx,x+10,fy-28,2,10,Math.floor(t*2)%2?'#2ee6cf':'#1a5f66');rect(ctx,x+2,fy-8,10,4,'#0a0c10')}
function sofaSide(ctx,x,fy){rect(ctx,x,fy-14,30,6,'#3a2b3f');rect(ctx,x,fy-8,30,6,'#4a3652');rect(ctx,x-2,fy-10,3,8,'#3a2b3f');rect(ctx,x+29,fy-10,3,8,'#3a2b3f');rect(ctx,x+1,fy-13,28,1,'#5c4566');rect(ctx,x+2,fy-2,2,2,'#0d1018');rect(ctx,x+26,fy-2,2,2,'#0d1018')}
function plantSide(ctx,x,fy,t){rect(ctx,x,fy-8,10,8,'#3d2f27');rect(ctx,x+1,fy-9,8,1,'#5a4436');const sway=Math.round(Math.sin(t*1.5+x));rect(ctx,x+4,fy-18,2,10,'#2f7d4a');rect(ctx,x+1+sway,fy-22,4,6,'#3fa35f');rect(ctx,x+6-sway,fy-24,4,7,'#3fa35f');rect(ctx,x+3,fy-27,4,5,'#56c47a')}
function windowSide(ctx,x,y,w,h,t,seed){rect(ctx,x,y,w,h,'#0d1018');rect(ctx,x+3,y+3,w-6,h-6,'#0a0f1f');stars(ctx,x+3,y+3,w-6,h/2,seed,t);const r=rnd(seed);let bx=x+4;while(bx<x+w-8){const bw=4+Math.floor(r()*8),bh=6+Math.floor(r()*(h/2));rect(ctx,bx,y+h-3-bh,bw,bh,'#111626');for(let i=0;i<3;i++)rect(ctx,bx+1+Math.floor(r()*(bw-2)),y+h-2-bh+Math.floor(r()*(bh-2)),1,1,r()>.5?'#f5b34a':'#2ee6cf');bx+=bw+2}rect(ctx,x+w/2-1,y+3,2,h-6,'#0d1018');rect(ctx,x+3,y+h/2,w-6,2,'#0d1018')}

function renderSideB(ctx,world,S){
  const W=world.W,BH=120,H=BH*3,t=world.t;ctx.setTransform(S,0,0,S,0,0);ctx.clearRect(0,0,W,H);const tags=[];
  const bt=f=>(2-f)*BH,fyOf=(f,ly)=>bt(f)+84+ly*.35;
  for(let f=0;f<3;f++){const b=bt(f);rect(ctx,0,b,W,72,f===2?'#1d2233':'#1b2030');for(let x=0;x<W;x+=32)rect(ctx,x,b,1,72,'#171b29');rect(ctx,0,b,W,3,'#12151f');
    rect(ctx,0,b+69,W,3,'#0e1016');rect(ctx,0,b+72,W,48,f===2?'#2a2538':'#252938');for(let y=b+72;y<b+120;y+=9){rect(ctx,0,y,W,1,'#1f2331');const off=((y-b-72)/9)%2?24:0;for(let x=off;x<W;x+=48)rect(ctx,x,y,1,9,'#1f2331')}
    if(f<2){rect(ctx,0,b+117,W,3,'#0a0c12')}}
  // stairs between floors (bottom x=34 → top x=10)
  for(let f=0;f<2;f++){const y0=fyOf(f,CORR),y1=fyOf(f+1,CORR);const n=10;for(let i=0;i<=n;i++){const k=i/n;const sx=34-24*k,sy=y0+(y1-y0)*k;rect(ctx,sx-4,sy-2,8,2,'#3a3f52');rect(ctx,sx-4,sy,8,1,'#0d1018')}rect(ctx,8,y1-14,1,14,'#0d1018');rect(ctx,8,y1-14,26,1,'#8a929e');rect(ctx,36,y0-14,1,14,'#0d1018');rect(ctx,10,y1-13,27,1,'#5b6472');rect(ctx,2,y1-20,W*0+40,1,'#0d1018')}
  rect(ctx,2,bt(0)+110,W-4,1,'#0a0c12');
  // windows
  windowSide(ctx,230,bt(0)+8,60,34,t,11);windowSide(ctx,250,bt(1)+8,60,34,t,23);windowSide(ctx,290,bt(2)+8,50,34,t,31);windowSide(ctx,150,bt(1)+8,40,34,t,41);
  // moon in top window
  rect(ctx,320,bt(2)+14,7,7,'#f5efd0');rect(ctx,322,bt(2)+13,3,1,'#f5efd0');rect(ctx,322,bt(2)+21,3,1,'#f5efd0');
  // board on floor 0
  drawBoard(ctx,world,world.boardPos.x,bt(0)+8,60,52);tags.push({x:80,y:bt(0)+8,text:'BOARD',color:'#2ee6cf'});
  // clock + poster
  rect(ctx,120,bt(0)+12,12,12,'#0d1018');rect(ctx,121,bt(0)+13,10,10,'#e7eaf0');rect(ctx,126,bt(0)+14,1,5,'#1a1c24');rect(ctx,126,bt(0)+18,3,1,'#1a1c24');
  rect(ctx,80,bt(1)+10,22,30,'#0d1018');rect(ctx,81,bt(1)+11,20,28,'#1d2a3a');rect(ctx,84,bt(1)+16,14,3,'#2ee6cf');rect(ctx,84,bt(1)+22,10,2,'#c8cfda');rect(ctx,84,bt(1)+26,14,2,'#c8cfda');rect(ctx,84,bt(1)+30,7,2,'#c8cfda');
  // department signs
  world.departments.forEach(d=>{if(d.x1<=d.x0)return;const b=bt(d.floor),w=d.x1-d.x0;rect(ctx,d.x0+4,b+46,w-8,11,'#0d1018');rect(ctx,d.x0+5,b+47,w-10,9,'#12171f');rect(ctx,d.x0+6,b+55,w-12,1,d.color);tags.push({x:(d.x0+d.x1)/2,y:b+56,text:d.name.toUpperCase(),color:d.color})});
  // lounge (floor 2)
  const lf=fyOf(2,30);rect(ctx,140,lf+4,W-150,18,'#3a2b3f');rect(ctx,142,lf+6,W-154,14,'#2f2436');rect(ctx,144,lf+8,W-158,10,'#3a2b3f');
  arcadeSide(ctx,world.arcadePos.x,lf,t);coffeeSide(ctx,world.coffeePos.x,lf,t);vendingSide(ctx,world.vendingPos.x,lf,t);sofaSide(ctx,world.sofaPos.x,lf);plantSide(ctx,322,lf,t);plantSide(ctx,330,fyOf(0,50)+8,t);plantSide(ctx,300,fyOf(1,50)+8,t);
  rect(ctx,150,bt(2)+46,60,11,'#0d1018');rect(ctx,151,bt(2)+47,58,9,'#12171f');rect(ctx,152,bt(2)+55,56,1,'#f5b34a');tags.push({x:180,y:bt(2)+56,text:'LOUNGE',color:'#f5b34a'});
  // desks
  world.desks.forEach((d,i)=>{const f=world.floorOf(d.y),fy=fyOf(f,30);const seated=drawDeskSide(ctx,world,d,fy,t,i);if(d.agent&&seated)tags.push({x:d.x+7,y:fy+12,text:d.agent.name,color:d.agent.color})});
  // moving / standing agents
  const pos=a=>{const k=(a.y-CORR)/FL,fl=Math.floor(k+1e-6),frac=k-fl;if(frac>1e-3&&a.x<=34.5&&fl>=0&&fl<2){return fyOf(fl,CORR)+(fyOf(fl+1,CORR)-fyOf(fl,CORR))*frac}const f=world.floorOf(a.y);return fyOf(f,a.y-f*FL)};
  world.agents.filter(a=>['walk','grab','coffee','arcade'].includes(a.state)).sort((p,q)=>pos(p)-pos(q)).forEach(a=>{const fy=pos(a);let rows=walkRows(a,t),flip=a.dir<0;if(a.state==='arcade'){rows=SPR.back_stand;flip=false}
    spr(ctx,rows,pal(a),a.x,fy-19,flip);if(a.task&&(a.state==='walk'||a.state==='grab'))rect(ctx,a.x+(flip?-1:7),fy-9,4,3,a.task.color);bubble(ctx,a,a.x+3,fy-27);tags.push({x:a.x+5,y:fy+12,text:a.name,color:a.color})});
  labels(ctx,S,tags);
}

function renderIsoB(ctx,world,S){
  const W=world.W,D=world.D,t=world.t,kx=.6,ky=.72,OX=D*ky+10,OY=40,Wc=Math.round(W*kx+D*ky+20),H=Math.round((W*kx+D*ky)*.5+80);
  if(ctx.canvas.width!==Wc*S||ctx.canvas.height!==H*S){ctx.canvas.width=Wc*S;ctx.canvas.height=H*S}
  ctx.setTransform(S,0,0,S,0,0);ctx.clearRect(0,0,Wc,H);const tags=[];
  const P=(x,y)=>[OX+x*kx-y*ky,OY+(x*kx+y*ky)*.5];
  const poly=(pts,col)=>{ctx.fillStyle=col;ctx.beginPath();pts.forEach((p,i)=>i?ctx.lineTo(p[0],p[1]):ctx.moveTo(p[0],p[1]));ctx.closePath();ctx.fill()};
  const box=(x,y,w,d,h,top,l,r)=>{const p1=P(x,y),p2=P(x+w,y),p3=P(x+w,y+d),p4=P(x,y+d);const up=p=>[p[0],p[1]-h];poly([up(p1),up(p2),up(p3),up(p4)],top);poly([up(p4),up(p3),p3,p4],l);poly([up(p3),up(p2),p2,p3],r)};
  const wallH=46,A=P(0,0),B=P(W,0),C=P(0,D);
  poly([[A[0],A[1]-wallH],[B[0],B[1]-wallH],B,A],'#1b2030');poly([[A[0],A[1]-wallH],[C[0],C[1]-wallH],C,A],'#151a27');poly([[A[0],A[1]-wallH-2],[B[0],B[1]-wallH-2],[B[0],B[1]-wallH],[A[0],A[1]-wallH]],'#0e1016');
  for(let i=0;i<W/16;i++)for(let j=0;j<D/15;j++){const x=i*16,y=j*15;const lounge=y>=150&&x>=140;poly([P(x,y),P(x+16,y),P(x+16,y+15),P(x,y+15)],lounge?((i+j)%2?'#2a2538':'#2e2940'):((i+j)%2?'#262a38':'#2a2e3d'))}
  // corridor strip (stairs zone) + rugs
  for(let j=3;j<D/15;j++)poly([P(6,j*15),P(40,j*15),P(40,j*15+15),P(6,j*15+15)],j%2?'#2d3142':'#30344a');
  ctx.save();ctx.setTransform(S*kx,S*kx*.5,0,S,A[0]*S,(A[1]-wallH)*S);
  drawBoard(ctx,world,50,6,60,36);for(const o of [160,260]){rect(ctx,o,4,60,30,'#0d1018');rect(ctx,o+3,6,54,25,'#0a0f1f');stars(ctx,o+3,6,54,16,7+o,t);rect(ctx,o+29,6,2,25,'#0d1018');rect(ctx,o+3,18,54,1,'#0d1018')}rect(ctx,300,10,6,6,'#f5efd0');
  rect(ctx,120,12,12,12,'#0d1018');rect(ctx,121,13,10,10,'#e7eaf0');rect(ctx,126,14,1,5,'#1a1c24');
  world.departments.forEach(d=>{if(d.floor!==0||d.x1<=d.x0)return;const w=d.x1-d.x0;rect(ctx,d.x0+4,38,w-8,7,'#0d1018');rect(ctx,d.x0+5,39,w-10,5,'#12171f');rect(ctx,d.x0+6,43,w-12,1,d.color);const wx=(d.x0+d.x1)/2;tags.push({x:A[0]+wx*kx,y:A[1]-wallH+wx*kx*.5+50,text:d.name.toUpperCase(),color:d.color})});ctx.restore();
  const draw=[];const z=(x,y)=>x*kx+y*ky;
  // zone dividers (glass) at y=75,150 from x=44
  [75,150].forEach(y=>{for(let x=44;x<W;x+=24){const w=Math.min(24,W-x);draw.push({z:z(x+w/2,y),f:()=>box(x,y-1,w,2,16,'#3a4a55','#1c2a33','#24363f')})}});
  // department signs (floating above zone)
  // floor 1-2 signs: plaques standing on the divider, at the divider's far-right end (clear of name tags)
  world.departments.forEach(d=>{if(d.x1<=d.x0||d.floor===0)return;const y=d.floor*FL,sx=d.x1-14;draw.push({z:z(sx,y)+.02,f:()=>{const q=P(sx,y);rect(ctx,q[0]-14,q[1]-30,28,9,'#0d1018');rect(ctx,q[0]-13,q[1]-29,26,7,'#12171f');rect(ctx,q[0]-12,q[1]-23,24,1,d.color);tags.push({x:q[0],y:q[1]-22,text:d.name.toUpperCase(),color:d.color})}})});
  draw.push({z:z(W-20,150)+.02,f:()=>{const q=P(W-24,150);rect(ctx,q[0]-14,q[1]-30,28,9,'#0d1018');rect(ctx,q[0]-13,q[1]-29,26,7,'#12171f');rect(ctx,q[0]-12,q[1]-23,24,1,'#f5b34a');tags.push({x:q[0],y:q[1]-22,text:'LOUNGE',color:'#f5b34a'})}});
  // lounge objects
  const ap=world.arcadePos;draw.push({z:z(ap.x+8,ap.y-4),f:()=>{box(ap.x,ap.y-9,16,10,30,'#2a2340','#1a1530','#221c38');const p=P(ap.x+16,ap.y-1);rect(ctx,p[0]-7,p[1]-30,10,3,'#c084fc');rect(ctx,p[0]-6,p[1]-26,8,6,'#0a0c10');const r=rnd(Math.floor(t*5));for(let i=0;i<4;i++)rect(ctx,p[0]-5+Math.floor(r()*6),p[1]-25+Math.floor(r()*4),1,1,['#2ee6cf','#f5b34a','#fff'][i%3]);rect(ctx,p[0]-6,p[1]-18,8,3,'#3a3050');rect(ctx,p[0]-4,p[1]-17,1,1,'#f87171');rect(ctx,p[0]-1,p[1]-17,1,1,'#2ee6cf')}});
  const cp=world.coffeePos;draw.push({z:z(cp.x+8,cp.y-4),f:()=>{box(cp.x,cp.y-9,16,10,22,'#3a4150','#20262f','#2a3040');const p=P(cp.x+16,cp.y-2);rect(ctx,p[0]-4,p[1]-20,6,4,'#0b1f24');rect(ctx,p[0]-3,p[1]-19,Math.floor(t*4)%5,1,'#2ee6cf');rect(ctx,p[0]-2,p[1]-9,3,3,'#e7eaf0')}});
  const vp=world.vendingPos;draw.push({z:z(vp.x+7,vp.y-4),f:()=>{box(vp.x,vp.y-9,14,10,28,'#1d2a3a','#101a26','#162230');const p=P(vp.x+14,vp.y-1);for(let r=0;r<4;r++)for(let c=0;c<3;c++)rect(ctx,p[0]-6+c*2,p[1]-26+r*4,1,2,['#f87171','#f5b34a','#4ade80','#7b8cff'][(r+c)%4]);rect(ctx,p[0]+1,p[1]-26,1,10,Math.floor(t*2)%2?'#2ee6cf':'#1a5f66')}});
  const sp=world.sofaPos;draw.push({z:z(sp.x+15,sp.y+4),f:()=>{box(sp.x,sp.y,30,10,6,'#4a3652','#2f2436','#3a2b3f');box(sp.x,sp.y-2,30,3,12,'#3a2b3f','#2a1e30','#33263a')}});
  const plant=(x,y)=>draw.push({z:z(x+4,y+4),f:()=>{box(x,y,8,8,6,'#5a4436','#3d2f27','#4a382e');const p=P(x+4,y+4);rect(ctx,p[0]-1,p[1]-16,2,10,'#2f7d4a');rect(ctx,p[0]-4,p[1]-20,4,6,'#3fa35f');rect(ctx,p[0]+1,p[1]-22,4,7,'#3fa35f');rect(ctx,p[0]-2,p[1]-25,4,5,'#56c47a')}});plant(W-16,200);plant(W-16,60);plant(W-16,130);plant(320,160);
  world.desks.forEach((d,i)=>{const a=d.agent,seated=a&&SEATED.includes(a.state);
    draw.push({z:z(d.x+14,d.y-4),f:()=>{box(d.x-2,d.y-8,30,10,14,'#5a4436','#3d2f27','#4a382e');const m=P(d.x+14,d.y-6);rect(ctx,m[0]-6,m[1]-27,13,11,'#0d1018');screenLines(ctx,m[0]-5,m[1]-26,11,9,a?world.status(a):'idle',t,i*13);rect(ctx,m[0]-1,m[1]-16,3,2,'#0d1018');const k=P(d.x+6,d.y-1);rect(ctx,k[0]-3,k[1]-16,7,2,'#20242f')}});
    draw.push({z:z(d.x+13,d.y+8),f:()=>{const ch=P(d.x+13,d.y+10);rect(ctx,ch[0]-5,ch[1]-8,10,3,'#20242f');rect(ctx,ch[0]-5,ch[1]-19,2,11,'#0d1018');rect(ctx,ch[0]-1,ch[1]-5,2,4,'#0d1018');rect(ctx,ch[0]-5,ch[1]-1,10,1,'#0d1018');
      if(seated){const p=P(d.x+13,d.y+8);const rows=a.state==='blocked'?SPR.side_stand:(a.state==='work'&&Math.floor(t*8)%2?SPR.sit2:SPR.sit);spr(ctx,rows,pal(a),p[0]-5,p[1]-(a.state==='blocked'?19:17),false);bubble(ctx,a,p[0]-1,p[1]-26)}}})});
  world.agents.filter(a=>['walk','grab','coffee','arcade'].includes(a.state)).forEach(a=>draw.push({z:z(a.x+5,a.y),f:()=>{const p=P(a.x+5,a.y);let rows,flip=false;const walking=a.state==='walk',f=Math.floor(t*7)%2;
    if(a.state==='arcade')rows=SPR.back_stand;else if(walking&&a.vdir==='front'){rows=f?SPR.side_walk:SPR.side_stand;flip=true}else if(walking&&a.vdir==='back')rows=f?SPR.back_walk:SPR.back_stand;else{rows=walking?(f?SPR.side_walk:SPR.side_stand):SPR.side_stand;flip=a.dir<0}
    spr(ctx,rows,pal(a),p[0]-5,p[1]-19,flip);if(a.task&&(a.state==='walk'||a.state==='grab'))rect(ctx,p[0]+(flip?-6:2),p[1]-9,4,3,a.task.color);bubble(ctx,a,p[0]-2,p[1]-27)}}));
  draw.sort((p,q)=>p.z-q.z).forEach(d=>d.f());
  labels(ctx,S,tags.concat(world.agents.map(a=>{const seated=!['walk','grab','coffee','arcade'].includes(a.state),d=world.desks[a.deskIdx];const p=seated?P(d.x+13,d.y+8):P(a.x+5,a.y);return{x:p[0],y:p[1]+12,text:a.name,color:a.color}})));
}
E.WorldB=WorldB;E.renderSideB=renderSideB;E.renderIsoB=renderIsoB;
})();

/* v4: depth-layered side view + refined iso; 16x24 sprites, accessories, day/night lighting, camera */
(function(){
const E=window.OfficeEngine,{rect,drawBoard,screenLines,stars,rnd,shade}=E._h;
const R=s=>(s+'................').slice(0,16);
const HEAD_S=['....hhhhhhh.....','...hhhhhhhhh....','..hhhhhhhhhhh...','..hhhhhssssss...','..hhhhsssssss...','..hhhhssssEss...','..hhhhsssssss...','...hhhssssss....','....sssssss.....','.....ssss.......'].map(R);
const TORSO_S=['....ccccccc.....','...ccccccccc....','..dccccccccc....','..dcccccccccc...','..dccccccccss...','..dcccccccc.....','...ccccccccc....'].map(R);
const LEGS_S=['...pppppppp.....','...pppp.ppp.....','...pppp.ppp.....','...pppp.ppp.....','...ppp..ppp.....','..kkkkk.kkkk....','..kkkkk.kkkk....'].map(R);
const WALK_A=['...pppppppp.....','..ppppp.pppp....','.pppp....pppp...','.ppp......ppp...','ppp........ppp..','kkkk.......kkkk.','kkkk.......kkkk.'].map(R);
const WALK_B=['...pppppppp.....','....pppppp......','....pppppp......','....ppp.pp......','....ppp.pp......','...kkkk.kkk.....','...kkkk.kkk.....'].map(R);
const SIT_A=['....ccccccc.....','...ccccccccc....','..dccccccccc....','..dcccccccccccs.','..dcccccccccccs.','..dcccccccc.....','..dpppppppppp...','...ppppppppppp..','...........ppp..','...........ppp..','...........ppp..','...........ppp..','..........kkkk..','..........kkkk..'].map(R);
const SIT_B=SIT_A.map((r,i)=>i===3?R('..dcccccccccc...'):i===4?R('..dccccccccccss.'):r);
const HEAD_F=['....hhhhhhhh....','...hhhhhhhhhh...','..hhhhhhhhhhhh..','..hhhsssssssshh.','..hhssssssssshh.','..hhsEssssssEhh.','..hhsssssssssh..','...hsssssssss...','....sssssss.....','.....sssss......'].map(R);
const HEAD_B=HEAD_F.map((r,i)=>i>=3&&i<=7?r.replace(/[sE]/g,'h'):r);
const TORSO_F=['...ccccccccccc..','..ccccccccccccc.','..ccccccccccccc.','..cc.ccccccc.cc.','..ss.ccccccc.ss.','.....ccccccc....','.....ppppppp....'].map(R);
const LEGS_F=['.....ppp.ppp....','.....ppp.ppp....','.....ppp.ppp....','.....ppp.ppp....','.....ppp.ppp....','....kkkk.kkkk...','....kkkk.kkkk...'].map(R);
const WALK_F=['.....ppp.ppp....','.....ppp.ppp....','.....ppp.ppp....','.....ppp........','.....ppp........','....kkkk.kkkk...','....kkkk........'].map(R);
const SP={side_stand:HEAD_S.concat(TORSO_S,LEGS_S),side_walkA:HEAD_S.concat(TORSO_S,WALK_A),side_walkB:HEAD_S.concat(TORSO_S,WALK_B),sit:HEAD_S.concat(SIT_A),sit2:HEAD_S.concat(SIT_B),front_stand:HEAD_F.concat(TORSO_F,LEGS_F),front_walk:HEAD_F.concat(TORSO_F,WALK_F),back_stand:HEAD_B.concat(TORSO_F,LEGS_F),back_walk:HEAD_B.concat(TORSO_F,WALK_F)};
const SKIN=['#f1c9a5','#e0ac7e','#c68642','#8d5524','#f7dcc4','#a86f45'],PANTS=['#2b3350','#23252e','#5b4a3a','#3a4a5a','#1e2a3a'],HAIRC=['#3a2418','#14151b','#c9903a','#6b3a2a','#e8e0d0','#8a3b2a','#b5651d','#4a4a4a'],ACC=['none','glasses','headphones','cap','beard','glasses','headphones'];
function look(a){const i=a.lookIdx||0;return{skin:SKIN[i%6],pants:PANTS[i%5],hair:HAIRC[(i*3)%8],acc:ACC[i%7],cap:['#e05a3a','#2f6fb3','#2a2a2a'][i%3]}}
function pal(a){const l=look(a);return{h:l.hair,s:l.skin,E:'#1a1c24',k:'#15161c',p:l.pants,c:a.color,d:shade(a.color,.62)}}
function spr(ctx,rows,p,x,y,flip){x=Math.round(x);y=Math.round(y);for(let r=0;r<rows.length;r++){const row=rows[r];for(let c=0;c<16;c++){const ch=row[flip?15-c:c];if(ch!=='.'&&p[ch]){ctx.fillStyle=p[ch];ctx.fillRect(x+c,y+r,1,1)}}}}
function acc(ctx,a,view,x,y,flip){const l=look(a);x=Math.round(x);y=Math.round(y);const px=(cx,cy,col)=>{ctx.fillStyle=col;ctx.fillRect(x+(flip?15-cx:cx),y+cy,1,1)};const side=view==='side',back=view==='back';
  if(l.acc==='glasses'&&!back){if(side){[8,9,10,11,12].forEach(c=>px(c,5,'#0d1018'));px(8,4,'#0d1018')}else{[3,4,5,6,8,9,10,11,12,13].forEach(c=>px(c,5,'#0d1018'))}}
  if(l.acc==='headphones'){const col='#20242f';if(side){[5,6,7,8,9].forEach(c=>px(c,0,col));px(4,1,col);px(10,1,col);[4,5].forEach(c=>{px(c,5,col);px(c,6,col)});px(5,4,col)}else{[4,5,6,7,8,9,10,11].forEach(c=>px(c,0,col));px(3,1,col);px(12,1,col);[2,3,12,13].forEach(c=>{px(c,4,col);px(c,5,col);px(c,6,col)})}}
  if(l.acc==='cap'){const col=l.cap,dk=shade(col,.7);if(side){for(let c=4;c<=10;c++)px(c,0,col);for(let c=3;c<=11;c++){px(c,1,col);px(c,2,col)}for(let c=10;c<=14;c++)px(c,3,dk)}else{for(let c=4;c<=11;c++)px(c,0,col);for(let c=3;c<=12;c++){px(c,1,col);px(c,2,col)}if(!back)for(let c=2;c<=13;c++)px(c,3,dk)}}
  if(l.acc==='beard'&&!back){const col=l.hair;if(side){[6,7,8,9,10].forEach(c=>{px(c,7,col);px(c,8,col)})}else{[4,5,6,7,8,9,10,11].forEach(c=>{px(c,7,col);px(c,8,col)})}}}
function agentSprite(ctx,a,kind,x,y,flip,t){let rows,view='side';const f=Math.floor(t*6)%2;
  if(kind==='sit')rows=(a.state==='work'&&f)?SP.sit2:SP.sit;else if(kind==='back'){rows=SP.back_stand;view='back'}else if(a.state==='walk'){if(a.vdir==='front'){rows=f?SP.front_walk:SP.front_stand;view='front'}else if(a.vdir==='back'){rows=f?SP.back_walk:SP.back_stand;view='back'}else rows=f?SP.side_walkA:SP.side_walkB}else rows=SP.side_stand;
  if(view!=='side')flip=false;spr(ctx,rows,pal(a),x,y,flip);acc(ctx,a,view,x,y,flip);if(a.task&&(a.state==='walk'||a.state==='grab'))rect(ctx,x+(flip?-1:12),y+13,5,4,a.task.color)}
function bubble(ctx,a,x,y,t){const s=a.state;if(s==='blocked'){rect(ctx,x-1,y-1,7,9,'#f87171');rect(ctx,x,y,5,7,'#2a0f12');rect(ctx,x+2,y+1,1,4,'#f87171');rect(ctx,x+2,y+6,1,1,'#f87171')}
  else if(s==='paused'||s==='pausing'){const p=Math.floor(t*2)%3;for(let i=0;i<=p;i++)rect(ctx,x+i*3,y-i*3,2,2,'#c8cfda')}
  else if(s==='coffee'){rect(ctx,x,y,4,4,'#e7eaf0');rect(ctx,x+4,y+1,1,2,'#e7eaf0');const k=Math.floor(t*4)%2;rect(ctx,x+1+k,y-3,1,2,'#c8cfda');rect(ctx,x+2-k,y-2,1,1,'#c8cfda')}
  else if(s==='arcade'){const k=Math.floor(t*6)%2;rect(ctx,x+k,y,2,2,'#f5b34a');rect(ctx,x+3-k,y-3,2,2,'#2ee6cf')}
  else if(s==='grab'){rect(ctx,x,y,5,4,a.task?a.task.color:'#fff');rect(ctx,x+1,y+1,3,1,'#fff')}
  else if(s==='work'||s==='resuming'){rect(ctx,x-5,y+1,14,3,'#0a0c12');rect(ctx,x-4,y+2,Math.max(1,Math.round(a.progress/8.4)),1,E.STATUS.working)}}
function lerpC(a,b,k){const A=parseInt(a.slice(1),16),B=parseInt(b.slice(1),16);const ch=s=>Math.round(((A>>s)&255)*(1-k)+((B>>s)&255)*k);return '#'+[16,8,0].map(s=>ch(s).toString(16).padStart(2,'0')).join('')}

const BACK=30,CORR=90,FRONT=140;
class WorldC extends E.World{
  constructor(cfg){super({departments:cfg.departments});this.W=500;this.D=160;this.cam=0;this.focusId=null;this.hits=[];this.hour=9;
    this.boardPos={x:10,y:14};this.arcadePos={x:400,y:70};this.coffeePos={x:428,y:70};this.vendingPos={x:452,y:70};this.sofaPos={x:474,y:70};
    this.desks=[];this.agents.forEach((a,i)=>a.lookIdx=i);
    cfg.rows.forEach((ds,ri)=>{let x=ri===0?96:60;const y=ri===0?BACK:FRONT;ds.forEach(di=>{const d=this.departments[di];if(!d)return;d.row=ri;d.x0=x-4;
      this.agents.filter(a=>a.dept===di).forEach(a=>{a.deskIdx=this.desks.length;this.desks.push({x,y,dept:di,agent:a,row:ri});a.x=x+2;a.y=y;x+=56});d.x1=x-56+54;x+=20})});
    this.departments.forEach(d=>{if(d.row===undefined){d.row=0;d.x0=d.x1=0}})}
  seat(a){const d=this.desks[a.deskIdx];return{x:d.x+2,y:d.y}}
  goTo(a,target,next){a.path=[{x:a.x,y:CORR},{x:target.x,y:CORR},{x:target.x,y:target.y}];a.state='walk';a.next=next}
  boardTarget(){return{x:46,y:64}}
  coffeeTarget(){return{x:this.coffeePos.x-14,y:78}}
  arcadeTarget(){return{x:this.arcadePos.x+4,y:78}}
  tick(dt){super.tick(dt);this.hour=(4+(this.t/150)*24)%24;const focus=this.agents.find(a=>a.id===this.focusId);let target;
    if(focus)target=focus.x-166;else target=(this.W-333)/2*(1+Math.sin(this.t*.05));target=Math.max(0,Math.min(this.W-333,target));this.cam+=(target-this.cam)*Math.min(1,dt*2)}
  daylight(){const h=this.hour;return Math.max(0,Math.sin((h-6)/12*Math.PI))}
  clock(){const h=Math.floor(this.hour),m=Math.floor((this.hour%1)*60);return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')}
}
const SEATED=['sit','work','paused','pausing','resuming','blocked'];
function skyColor(d){return lerpC('#0a0f1f','#9ccbee',d)}
function windowC(ctx,x,y,w,h,world,seed){const d=world.daylight(),t=world.t;rect(ctx,x-2,y-2,w+4,h+4,'#e8e2d6');rect(ctx,x-1,y-1,w+2,h+2,'#2a2f3a');rect(ctx,x,y,w,h,skyColor(d));
  const hz=lerpC('#161c33',lerpC('#f0b070','#cfe6f7',Math.min(1,d*1.6)),Math.min(1,d*1.3+.15));for(let i=0;i<8;i++)rect(ctx,x,y+h-16+i*2,w,2,lerpC(skyColor(d),hz,i/8));
  if(d<.5){ctx.save();ctx.globalAlpha=1-d*2;stars(ctx,x,y,w,h/2,seed,t);ctx.restore()}
  const sunY=y+h-6-Math.sin((world.hour-6)/12*Math.PI)*(h-8),sunX=x+6+((world.hour-6)/12)*(w-12);if(world.hour>6&&world.hour<18){rect(ctx,sunX,sunY,5,5,'#fff3c4');rect(ctx,sunX+1,sunY-1,3,1,'#fff3c4');rect(ctx,sunX+1,sunY+5,3,1,'#fff3c4')}else{const mx=x+w-14,my=y+8;rect(ctx,mx,my,6,6,'#f5efd0');rect(ctx,mx+1,my-1,4,1,'#f5efd0');rect(ctx,mx+1,my+6,4,1,'#f5efd0')}
  const r=rnd(seed);let bx=x+2;const bcol=lerpC('#111626','#5a6a86',d);while(bx<x+w-6){const bw=4+Math.floor(r()*7),bh=8+Math.floor(r()*(h*.45));rect(ctx,bx,y+h-bh,bw,bh,bcol);for(let i=0;i<4;i++){const lit=r()>(.3+d*.6);if(lit)rect(ctx,bx+1+Math.floor(r()*(bw-2)),y+h-bh+2+Math.floor(r()*(bh-3)),1,1,'#f5c76a')}bx+=bw+1}
  rect(ctx,x+w/2-1,y,2,h,'#2a2f3a');rect(ctx,x,y+h/2-1,w,2,'#2a2f3a')}
function deskC(ctx,x,fy,a,world,t,seed,night){const status=a?world.status(a):'idle';
  rect(ctx,x-1,fy-25,2,15,'#1c1f27');rect(ctx,x-3,fy-28,9,4,'#2a2f3a');rect(ctx,x-2,fy-27,7,2,'#3a4150');rect(ctx,x-2,fy-12,13,3,'#2a2f3a');rect(ctx,x-1,fy-11,11,1,'#3a4150');rect(ctx,x+4,fy-9,2,7,'#1c1f27');rect(ctx,x,fy-2,11,2,'#1c1f27');
  rect(ctx,x+12,fy-18,42,3,'#e2d9c8');rect(ctx,x+12,fy-15,42,1,'#b3a892');rect(ctx,x+12,fy-18,42,1,'#f4eee2');rect(ctx,x+14,fy-14,2,14,'#3a3f4a');rect(ctx,x+50,fy-14,2,14,'#3a3f4a');rect(ctx,x+14,fy-6,38,1,'#2a2f3a');
  rect(ctx,x+26,fy-35,19,14,'#14171f');rect(ctx,x+27,fy-34,17,12,'#0d1018');screenLines(ctx,x+28,fy-33,15,10,status,t,seed);rect(ctx,x+34,fy-21,3,3,'#14171f');rect(ctx,x+31,fy-19,9,1,'#14171f');
  rect(ctx,x+15,fy-20,10,2,'#20242f');rect(ctx,x+16,fy-20,8,1,'#3a4150');rect(ctx,x+47,fy-23,4,5,['#e7eaf0','#f5b34a','#7b8cff'][seed%3]);rect(ctx,x+51,fy-22,1,3,'#e7eaf0');
  if(seed%2){rect(ctx,x+20,fy-24,5,6,'#3d2f27');rect(ctx,x+21,fy-28,3,4,'#3fa35f');rect(ctx,x+19,fy-27,2,2,'#56c47a');rect(ctx,x+24,fy-27,2,3,'#2f7d4a')}
  rect(ctx,x+46,fy-40,1,22,'#3a3f4a');rect(ctx,x+40,fy-41,8,2,'#3a3f4a');rect(ctx,x+41,fy-39,6,1,'#f5e2b0');
  if(night>.15&&status!=='paused'){ctx.save();ctx.globalAlpha=.32*night;ctx.fillStyle='#ffd88a';ctx.beginPath();ctx.moveTo(x+41,fy-38);ctx.lineTo(x+47,fy-38);ctx.lineTo(x+55,fy-18);ctx.lineTo(x+33,fy-18);ctx.closePath();ctx.fill();ctx.globalAlpha=.18*night;ctx.fillStyle=E.STATUS[status]||'#2ee6cf';ctx.fillRect(x+20,fy-38,32,22);ctx.restore()}}
function arcadeC(ctx,x,fy,t,night){rect(ctx,x,fy-40,18,40,'#14121e');rect(ctx,x+1,fy-39,16,38,'#2a2340');rect(ctx,x+1,fy-39,16,5,'#c084fc');rect(ctx,x+3,fy-38,3,3,'#fff');rect(ctx,x+8,fy-38,6,3,'#f5b34a');rect(ctx,x+3,fy-32,12,10,'#0a0c10');const r=rnd(Math.floor(t*5));for(let i=0;i<6;i++)rect(ctx,x+4+Math.floor(r()*10),fy-31+Math.floor(r()*8),1,1,['#2ee6cf','#f5b34a','#fff','#f87171'][i%4]);rect(ctx,x+4+Math.floor(t*3)%9,fy-24,2,1,'#4ade80');
  rect(ctx,x+2,fy-20,14,5,'#3a3050');rect(ctx,x+4,fy-19,1,1,'#f87171');rect(ctx,x+10,fy-19,1,1,'#2ee6cf');rect(ctx,x+13,fy-19,1,1,'#f5b34a');rect(ctx,x+6,fy-23,1,4,'#8a929e');rect(ctx,x+2,fy-14,14,13,'#1e1a30');rect(ctx,x+6,fy-10,6,4,'#c084fc');
  if(night>.1){ctx.save();ctx.globalAlpha=.25*night;ctx.fillStyle='#c084fc';ctx.fillRect(x-4,fy-44,26,46);ctx.restore()}}
function coffeeC(ctx,x,fy,t){rect(ctx,x,fy-28,20,28,'#14171f');rect(ctx,x+1,fy-27,18,26,'#2a3040');rect(ctx,x+1,fy-27,18,2,'#3a4150');rect(ctx,x+3,fy-24,14,6,'#0b1f24');rect(ctx,x+4,fy-23,Math.floor(t*4)%12,1,'#2ee6cf');rect(ctx,x+4,fy-21,10,1,'#1f5f66');rect(ctx,x+7,fy-10,7,5,'#e7eaf0');rect(ctx,x+14,fy-9,1,3,'#e7eaf0');rect(ctx,x+9+Math.floor(t*3)%2,fy-15,1,4,'#8a929e');rect(ctx,x+3,fy-4,14,1,'#5a4436');rect(ctx,x+15,fy-18,3,3,'#f87171')}
function vendingC(ctx,x,fy,t){rect(ctx,x,fy-36,16,36,'#14171f');rect(ctx,x+1,fy-35,14,34,'#1d2a3a');rect(ctx,x+2,fy-34,8,22,'#0a0f1f');for(let r=0;r<5;r++)for(let c=0;c<3;c++)rect(ctx,x+3+c*2,fy-33+r*4,1,3,['#f87171','#f5b34a','#4ade80','#7b8cff','#2ee6cf'][(r+c)%5]);rect(ctx,x+11,fy-34,3,12,Math.floor(t*2)%2?'#2ee6cf':'#1a5f66');rect(ctx,x+11,fy-20,3,3,'#3a4150');rect(ctx,x+2,fy-9,12,5,'#0a0c10')}
function sofaC(ctx,x,fy){rect(ctx,x,fy-16,34,7,'#4a3652');rect(ctx,x+1,fy-16,32,1,'#5c4566');rect(ctx,x,fy-9,34,7,'#3a2b3f');rect(ctx,x-2,fy-12,3,10,'#4a3652');rect(ctx,x+33,fy-12,3,10,'#4a3652');rect(ctx,x+2,fy-2,3,2,'#14171f');rect(ctx,x+29,fy-2,3,2,'#14171f');rect(ctx,x+6,fy-14,8,4,'#f5b34a');rect(ctx,x+20,fy-14,8,4,'#2ee6cf')}
function plantC(ctx,x,fy,t,big){rect(ctx,x,fy-9,10,9,'#5a4436');rect(ctx,x,fy-9,10,1,'#7a5c48');rect(ctx,x+1,fy-9,8,1,'#3d2f27');const sw=Math.round(Math.sin(t*1.5+x));const h=big?14:10;rect(ctx,x+4,fy-9-h,2,h,'#2f7d4a');rect(ctx,x+1+sw,fy-13-h,4,7,'#3fa35f');rect(ctx,x+6-sw,fy-15-h,4,8,'#3fa35f');rect(ctx,x+3,fy-18-h,4,6,'#56c47a');rect(ctx,x-1+sw,fy-8-h,3,5,'#2f7d4a')}
function shelfC(ctx,x,fy){rect(ctx,x,fy-44,24,44,'#3d2f27');rect(ctx,x+1,fy-43,22,42,'#5a4436');for(let s=0;s<3;s++){const sy=fy-40+s*13;rect(ctx,x+1,sy+11,22,1,'#3d2f27');const r=rnd(x+s);let bx=x+2;while(bx<x+21){const w=2+Math.floor(r()*2),h=6+Math.floor(r()*5);rect(ctx,bx,sy+11-h,w,h,['#7b8cff','#f5b34a','#2ee6cf','#f87171','#c8cfda','#4ade80'][Math.floor(r()*6)]);bx+=w+1}}}
function coolerC(ctx,x,fy,t){rect(ctx,x,fy-30,10,30,'#c8cfda');rect(ctx,x+1,fy-29,8,28,'#e7eaf0');rect(ctx,x+1,fy-42,8,12,'#9ecfea');rect(ctx,x+2,fy-41,6,10,'#bfe3f5');rect(ctx,x+2,fy-41,6,Math.floor(t*2)%3,'#9ecfea');rect(ctx,x+3,fy-18,4,3,'#3a4150');rect(ctx,x+4,fy-14,2,2,'#2ee6cf')}
function pendant(ctx,x,y,night){rect(ctx,x,y-6,1,6,'#3a3f4a');rect(ctx,x-5,y,11,3,'#2a2f3a');rect(ctx,x-4,y+3,9,1,'#fff3c4');if(night>.1){ctx.save();ctx.globalAlpha=.22*night;const g=ctx.createRadialGradient(x,y+4,2,x,y+4,46);g.addColorStop(0,'#ffe0a0');g.addColorStop(1,'rgba(255,224,160,0)');ctx.fillStyle=g;ctx.fillRect(x-46,y,92,60);ctx.restore()}}
function labelsPx(ctx,items){ctx.setTransform(1,0,0,1,0,0);ctx.font='9px Silkscreen, monospace';ctx.textAlign='center';for(const it of items){const w=ctx.measureText(it.text).width+8;ctx.fillStyle='rgba(8,9,12,.82)';ctx.fillRect(it.x-w/2,it.y-11,w,13);ctx.fillStyle=it.color||'#c8cfda';ctx.fillText(it.text,it.x,it.y-1)}}

function renderSideC(ctx,world){
  const t=world.t,d=world.daylight(),night=1-d,cam=Math.round(world.cam);const CW=1000,CH=620;ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,CW,CH);const tags=[],hits=[];
  // ---------- back layer (S=2, static) ----------
  ctx.setTransform(2,0,0,2,0,0);const W=world.W;
  const wallTop=lerpC('#1e2433','#4b5670',d),wallBot=lerpC('#181d2a','#3f4960',d);for(let y=0;y<110;y+=2)rect(ctx,0,y,W,2,lerpC(wallTop,wallBot,y/110));
  for(let x=0;x<W;x+=40)rect(ctx,x,0,1,110,'rgba(0,0,0,.08)');rect(ctx,0,0,W,4,lerpC('#121620','#2f3748',d));rect(ctx,0,104,W,6,lerpC('#2a2f3a','#6a7085',d));rect(ctx,0,110,W,2,'#14171f');
  for(let y=112;y<200;y+=6){const k=(y-112)/88;rect(ctx,0,y,W,6,lerpC(lerpC('#2c2620','#3d342c',k),lerpC('#56483c','#6d5c4c',k),d));rect(ctx,0,y,W,1,'rgba(0,0,0,.25)');const off=((y-112)/6)%2?30:0;for(let x=off;x<W;x+=60)rect(ctx,x,y,1,6,'rgba(0,0,0,.2)')}
  for(let x=60;x<W;x+=100)pendant(ctx,x,10,night);
  windowC(ctx,132,16,58,56,world,11);windowC(ctx,300,16,58,56,world,23);windowC(ctx,440,16,56,56,world,31);
  // wall decor
  rect(ctx,100,20,14,14,'#e8e2d6');rect(ctx,101,21,12,12,'#0d1018');rect(ctx,102,22,10,10,'#f4f1ea');{const cx=107,cy=27,ha=(world.hour%12)/12*Math.PI*2-Math.PI/2,ma=(world.hour%1)*Math.PI*2-Math.PI/2;ctx.strokeStyle='#1a1c24';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(cx,cy);ctx.lineTo(cx+Math.cos(ha)*3,cy+Math.sin(ha)*3);ctx.stroke();ctx.beginPath();ctx.moveTo(cx,cy);ctx.lineTo(cx+Math.cos(ma)*4.5,cy+Math.sin(ma)*4.5);ctx.stroke()}
  [[200,20],[228,20],[256,20],[372,20],[400,20]].forEach(([x,y],i)=>{rect(ctx,x,y,22,30,'#e8e2d6');rect(ctx,x+1,y+1,20,28,['#1d2a3a','#2a1e30','#1e2a24','#2a2418','#1a2230'][i]);rect(ctx,x+4,y+6,14,3,['#2ee6cf','#c084fc','#4ade80','#f5b34a','#7b8cff'][i]);rect(ctx,x+4,y+12,10,2,'#c8cfda');rect(ctx,x+4,y+16,14,2,'#c8cfda');rect(ctx,x+4,y+20,7,2,'#c8cfda')});
  drawBoard(ctx,world,10,14,74,56);tags.push({x:47*2,y:14*2-2,text:'TASK BOARD',color:'#2ee6cf'});
  world.departments.forEach(dp=>{if(dp.row!==0||dp.x1<=dp.x0)return;const w=dp.x1-dp.x0;rect(ctx,dp.x0+6,80,w-12,10,'#14171f');rect(ctx,dp.x0+7,81,w-14,8,'#1c2230');rect(ctx,dp.x0+8,88,w-16,1,dp.color);tags.push({x:(dp.x0+dp.x1),y:89*2-1,text:dp.name.toUpperCase(),color:dp.color})});
  // window light shafts
  if(d>.05){ctx.save();ctx.globalAlpha=.10*d;ctx.fillStyle='#ffe9b0';[[132,58],[300,58],[440,56]].forEach(([x,w])=>{ctx.beginPath();ctx.moveTo(x,72);ctx.lineTo(x+w,72);ctx.lineTo(x+w+26,200);ctx.lineTo(x-14,200);ctx.closePath();ctx.fill()});ctx.restore()}
  // lounge (corridor back edge)
  const LF=150;rect(ctx,384,LF-2,116,28,'#4a3a48');rect(ctx,386,LF,112,24,'#3a2b3f');for(let i=0;i<5;i++)rect(ctx,390+i*22,LF+4,12,16,'#4a3652');
  shelfC(ctx,360,LF);arcadeC(ctx,world.arcadePos.x,LF,t,night);coffeeC(ctx,world.coffeePos.x,LF,t);vendingC(ctx,world.vendingPos.x,LF,t);sofaC(ctx,world.sofaPos.x,LF);coolerC(ctx,486,LF-4,t);plantC(ctx,340,LF+2,t,true);plantC(ctx,88,LF+6,t,false);
  rect(ctx,392,80,60,10,'#14171f');rect(ctx,393,81,58,8,'#1c2230');rect(ctx,394,88,56,1,'#f5b34a');tags.push({x:422*2,y:89*2-1,text:'LOUNGE',color:'#f5b34a'});
  // back-row desks + seated agents
  const BFY=128;world.desks.filter(dk=>dk.row===0).forEach((dk,i)=>{const a=dk.agent,seated=SEATED.includes(a.state);deskC(ctx,dk.x,BFY,a,world,t,i+1,night);
    if(seated){if(a.state==='blocked'){agentSprite(ctx,a,'stand',dk.x+1,BFY-24,false,t);bubble(ctx,a,dk.x+6,BFY-32,t)}else{agentSprite(ctx,a,'sit',dk.x+2,BFY-24,false,t);bubble(ctx,a,dk.x+6,BFY-31,t)}
      tags.push({x:(dk.x+9)*2,y:BFY*2+14,text:a.name,color:a.color});hits.push({id:a.id,x:dk.x*2,y:(BFY-26)*2,w:32,h:52})}});
  // corridor agents (world y in (BACK, 120]) at S=2
  const corrY=y=>150+(y-60)*.8;
  world.agents.filter(a=>!SEATED.includes(a.state)&&a.y<=120).sort((p,q)=>p.y-q.y).forEach(a=>{const fy=Math.round(corrY(Math.max(a.y,60)));const kind=a.state==='arcade'?'back':'stand';agentSprite(ctx,a,kind,a.x,fy-24,a.dir<0,t);bubble(ctx,a,a.x+6,fy-31,t);
    tags.push({x:(a.x+8)*2,y:fy*2+14,text:a.name,color:a.color});hits.push({id:a.id,x:a.x*2,y:(fy-26)*2,w:32,h:52});if(a.id===world.focusId){const k=Math.floor(t*4)%2;rect(ctx,a.x+6,fy-36-k,4,2,'#fff');rect(ctx,a.x+7,fy-34-k,2,2,'#fff')}});
  // ---------- front layer (S=3, camera) ----------
  ctx.setTransform(3,0,0,3,-cam*3,0);
  for(let y=133;y<207;y+=5){const k=(y-133)/74;rect(ctx,cam-2,y,340,5,lerpC(lerpC('#3d342c','#4a3f35',k),lerpC('#6d5c4c','#80705e',k),d));rect(ctx,cam-2,y,340,1,'rgba(0,0,0,.22)');const off=((y-133)/5)%2?25:0;for(let x=Math.floor(cam/50)*50+off-50;x<cam+345;x+=50)rect(ctx,x,y,1,5,'rgba(0,0,0,.18)')}
  const FFY=200;world.departments.forEach(dp=>{if(dp.row!==1||dp.x1<=dp.x0)return;rect(ctx,dp.x0-2,FFY+2,dp.x1-dp.x0+4,1,dp.color);tags.push({x:((dp.x0+dp.x1)/2-cam)*3,y:CH-4,text:dp.name.toUpperCase(),color:dp.color})});
  world.agents.filter(a=>!SEATED.includes(a.state)&&a.y>120).forEach(a=>{const fy=133+(a.y-120)*3.35;agentSprite(ctx,a,'stand',a.x,fy-24,a.dir<0,t);tags.push({x:(a.x+8-cam)*3,y:fy*3+14,text:a.name,color:a.color});hits.push({id:a.id,x:(a.x-cam)*3,y:(fy-26)*3,w:48,h:78})});
  world.desks.filter(dk=>dk.row===1).forEach((dk,i)=>{const a=dk.agent,seated=SEATED.includes(a.state);deskC(ctx,dk.x,FFY,a,world,t,i+7,night);
    if(seated){if(a.state==='blocked'){agentSprite(ctx,a,'stand',dk.x+1,FFY-24,false,t);bubble(ctx,a,dk.x+6,FFY-32,t)}else{agentSprite(ctx,a,'sit',dk.x+2,FFY-24,false,t);bubble(ctx,a,dk.x+6,FFY-31,t)}
      tags.push({x:(dk.x+9-cam)*3,y:(FFY-44)*3,text:a.name,color:a.color});hits.push({id:a.id,x:(dk.x-cam)*3,y:(FFY-26)*3,w:48,h:78});if(a.id===world.focusId){const k=Math.floor(t*4)%2;rect(ctx,dk.x+8,FFY-50-k,4,2,'#fff');rect(ctx,dk.x+9,FFY-48-k,2,2,'#fff')}}});
  // ---------- lighting ----------
  ctx.setTransform(1,0,0,1,0,0);ctx.fillStyle='rgba(14,22,58,'+(.42*night).toFixed(3)+')';ctx.fillRect(0,0,CW,CH);
  if(d>0&&d<.6){ctx.fillStyle='rgba(255,140,80,'+(.08*(1-Math.abs(d-.3)/.3)).toFixed(3)+')';ctx.fillRect(0,0,CW,CH)}
  labelsPx(ctx,tags.filter(x=>x.x>-40&&x.x<CW+40));world.hits=hits;
}

/* ---------- iso (refined, unit scale, camera) ---------- */
function renderIsoC(ctx,world){
  const t=world.t,d=world.daylight(),night=1-d,W=world.W,D=world.D,CW=1000,CH=620,S=2;ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,CW,CH);const tags=[],hits=[];
  const focus=world.agents.find(a=>a.id===world.focusId);const fx=focus?focus.x:250+Math.sin(world.t*.05)*150,fyw=focus?focus.y:85;
  world.icam=world.icam||{x:0,y:0};const tx=(fx-fyw),ty=(fx+fyw)/2;world.icam.x+=((tx)-world.icam.x)*.03;world.icam.y+=((ty)-world.icam.y)*.03;
  const OX=CW/2/S-world.icam.x,OY=CH/2/S-world.icam.y+10;const P=(x,y)=>[Math.round(OX+x-y),Math.round(OY+(x+y)/2)];
  ctx.setTransform(S,0,0,S,0,0);
  const poly=(pts,col)=>{ctx.fillStyle=col;ctx.beginPath();pts.forEach((p,i)=>i?ctx.lineTo(p[0],p[1]):ctx.moveTo(p[0],p[1]));ctx.closePath();ctx.fill()};
  const box=(x,y,w,dd,h,top,l,r)=>{const p1=P(x,y),p2=P(x+w,y),p3=P(x+w,y+dd),p4=P(x,y+dd);const up=p=>[p[0],p[1]-h];poly([up(p1),up(p2),up(p3),up(p4)],top);poly([up(p4),up(p3),p3,p4],l);poly([up(p3),up(p2),p2,p3],r)};
  const wallH=64,A=P(0,0),B=P(W,0),C=P(0,D);
  poly([[A[0],A[1]-wallH],[B[0],B[1]-wallH],B,A],lerpC('#1e2433','#4b5670',d));poly([[A[0],A[1]-wallH],[C[0],C[1]-wallH],C,A],lerpC('#161b28','#3a4358',d));poly([[A[0],A[1]-wallH-3],[B[0],B[1]-wallH-3],[B[0],B[1]-wallH],[A[0],A[1]-wallH]],'#12151f');
  for(let i=0;i<W/20;i++)for(let j=0;j<D/20;j++){const x=i*20,y=j*20;const lounge=y>=60&&y<120&&x>=380;const base=lounge?((i+j)%2?'#3a2b3f':'#432f47'):((i+j)%2?'#3d342c':'#46392f');poly([P(x,y),P(x+20,y),P(x+20,y+20),P(x,y+20)],lerpC(base,shade(base,1.5),d*.5))}
  // corridor runner
  for(let i=0;i<W/20;i++)poly([P(i*20,80),P(i*20+20,80),P(i*20+20,100),P(i*20,100)],i%2?'#2d3142':'#30344a');
  // wall content (shear)
  ctx.save();ctx.setTransform(S,S*.5,0,S,A[0]*S,(A[1]-wallH)*S);
  drawBoard(ctx,world,10,8,74,50);windowC(ctx,132,10,58,44,world,11);windowC(ctx,300,10,58,44,world,23);windowC(ctx,440,10,56,44,world,31);
  rect(ctx,100,12,14,14,'#e8e2d6');rect(ctx,101,13,12,12,'#0d1018');rect(ctx,102,14,10,10,'#f4f1ea');[[200,12],[228,12],[256,12],[372,12]].forEach(([x,y],i)=>{rect(ctx,x,y,22,30,'#e8e2d6');rect(ctx,x+1,y+1,20,28,['#1d2a3a','#2a1e30','#1e2a24','#2a2418'][i]);rect(ctx,x+4,y+6,14,3,['#2ee6cf','#c084fc','#4ade80','#f5b34a'][i]);rect(ctx,x+4,y+12,10,2,'#c8cfda');rect(ctx,x+4,y+16,14,2,'#c8cfda')});
  world.departments.forEach(dp=>{if(dp.row!==0||dp.x1<=dp.x0)return;const w=dp.x1-dp.x0;rect(ctx,dp.x0+6,52,w-12,9,'#14171f');rect(ctx,dp.x0+7,53,w-14,7,'#1c2230');rect(ctx,dp.x0+8,59,w-16,1,dp.color);const wx=(dp.x0+dp.x1)/2;tags.push({x:(A[0]+wx)*S,y:(A[1]-wallH+wx*.5+66)*S,text:dp.name.toUpperCase(),color:dp.color})});ctx.restore();
  if(d>.05){ctx.save();ctx.globalAlpha=.10*d;ctx.fillStyle='#ffe9b0';[[132,58],[300,58],[440,56]].forEach(([x,w])=>poly([P(x,0),P(x+w,0),P(x+w+30,70),P(x-10,70)],'#ffe9b0'));ctx.restore()}
  const draw=[];const z=(x,y)=>x+y;
  const deskIso=(dk,i)=>{const a=dk.agent,st=world.status(a),seated=SEATED.includes(a.state);
    draw.push({z:z(dk.x+30,dk.y-4),f:()=>{box(dk.x+10,dk.y-10,44,14,16,'#e2d9c8','#b3a892','#cfc5b2');const m=P(dk.x+34,dk.y-8);rect(ctx,m[0]-9,m[1]-30,19,14,'#14171f');rect(ctx,m[0]-8,m[1]-29,17,12,'#0d1018');screenLines(ctx,m[0]-7,m[1]-28,15,10,st,t,i*13);rect(ctx,m[0]-1,m[1]-16,3,2,'#14171f');rect(ctx,m[0]-4,m[1]-14,9,1,'#14171f');const k=P(dk.x+22,dk.y-2);rect(ctx,k[0]-5,k[1]-17,10,2,'#20242f');const g=P(dk.x+48,dk.y-6);rect(ctx,g[0],g[1]-22,4,5,['#e7eaf0','#f5b34a','#7b8cff'][i%3]);if(i%2){const pl=P(dk.x+16,dk.y-6);rect(ctx,pl[0],pl[1]-23,4,5,'#3d2f27');rect(ctx,pl[0]+1,pl[1]-27,3,4,'#3fa35f');rect(ctx,pl[0]-1,pl[1]-26,2,2,'#56c47a')}
      if(night>.15&&st!=='paused'){ctx.save();ctx.globalAlpha=.16*night;ctx.fillStyle=E.STATUS[st]||'#2ee6cf';ctx.fillRect(m[0]-18,m[1]-34,40,26);ctx.restore()}}});
    draw.push({z:z(dk.x+4,dk.y+10),f:()=>{const ch=P(dk.x+4,dk.y+10);rect(ctx,ch[0]-6,ch[1]-8,12,3,'#2a2f3a');rect(ctx,ch[0]-6,ch[1]-26,2,18,'#1c1f27');rect(ctx,ch[0]-7,ch[1]-29,9,4,'#2a2f3a');rect(ctx,ch[0]-1,ch[1]-5,2,4,'#1c1f27');rect(ctx,ch[0]-6,ch[1]-1,12,1,'#1c1f27');
      if(seated){const p=P(dk.x+6,dk.y+8);if(a.state==='blocked')agentSprite(ctx,a,'stand',p[0]-6,p[1]-26,false,t);else agentSprite(ctx,a,'sit',p[0]-6,p[1]-24,false,t);bubble(ctx,a,p[0]-2,p[1]-32,t);tags.push({x:p[0]*S,y:(p[1]+12)*S,text:a.name,color:a.color});hits.push({id:a.id,x:(p[0]-8)*S,y:(p[1]-26)*S,w:32,h:56});if(a.id===world.focusId){const k=Math.floor(t*4)%2;rect(ctx,p[0]-2,p[1]-38-k,4,2,'#fff');rect(ctx,p[0]-1,p[1]-36-k,2,2,'#fff')}}}})};
  world.desks.forEach(deskIso);
  // lounge
  const ap=world.arcadePos;draw.push({z:z(ap.x+9,ap.y-4),f:()=>{box(ap.x,ap.y-12,18,12,38,'#2a2340','#1a1530','#221c38');const p=P(ap.x+18,ap.y-2);rect(ctx,p[0]-8,p[1]-38,12,4,'#c084fc');rect(ctx,p[0]-7,p[1]-33,10,8,'#0a0c10');const r=rnd(Math.floor(t*5));for(let i=0;i<5;i++)rect(ctx,p[0]-6+Math.floor(r()*8),p[1]-32+Math.floor(r()*6),1,1,['#2ee6cf','#f5b34a','#fff'][i%3]);rect(ctx,p[0]-7,p[1]-23,10,4,'#3a3050');rect(ctx,p[0]-5,p[1]-22,1,1,'#f87171');rect(ctx,p[0]-1,p[1]-22,1,1,'#2ee6cf');if(night>.1){ctx.save();ctx.globalAlpha=.22*night;ctx.fillStyle='#c084fc';ctx.fillRect(p[0]-14,p[1]-44,26,48);ctx.restore()}}});
  const cp=world.coffeePos;draw.push({z:z(cp.x+10,cp.y-4),f:()=>{box(cp.x,cp.y-12,20,12,26,'#3a4150','#20262f','#2a3040');const p=P(cp.x+20,cp.y-2);rect(ctx,p[0]-6,p[1]-24,8,5,'#0b1f24');rect(ctx,p[0]-5,p[1]-23,Math.floor(t*4)%6,1,'#2ee6cf');rect(ctx,p[0]-3,p[1]-11,4,4,'#e7eaf0')}});
  const vp=world.vendingPos;draw.push({z:z(vp.x+8,vp.y-4),f:()=>{box(vp.x,vp.y-12,16,12,34,'#1d2a3a','#101a26','#162230');const p=P(vp.x+16,vp.y-2);for(let r=0;r<5;r++)for(let c=0;c<3;c++)rect(ctx,p[0]-7+c*2,p[1]-32+r*4,1,3,['#f87171','#f5b34a','#4ade80','#7b8cff','#2ee6cf'][(r+c)%5]);rect(ctx,p[0]+1,p[1]-32,2,12,Math.floor(t*2)%2?'#2ee6cf':'#1a5f66')}});
  const sp=world.sofaPos;draw.push({z:z(sp.x+17,sp.y+5),f:()=>{box(sp.x,sp.y,34,12,7,'#4a3652','#2f2436','#3a2b3f');box(sp.x,sp.y-2,34,3,14,'#3a2b3f','#2a1e30','#33263a');const p=P(sp.x+10,sp.y+6);rect(ctx,p[0]-3,p[1]-12,6,4,'#f5b34a');const q=P(sp.x+24,sp.y+6);rect(ctx,q[0]-3,q[1]-12,6,4,'#2ee6cf')}});
  draw.push({z:z(372,66),f:()=>{box(360,60,24,8,42,'#5a4436','#3d2f27','#4a382e');const p=P(384,64);for(let s=0;s<3;s++){rect(ctx,p[0]-10,p[1]-40+s*13,16,1,'#3d2f27');const r=rnd(s);let bx=p[0]-9;while(bx<p[0]+4){const w=2,h=6+Math.floor(r()*4);rect(ctx,bx,p[1]-40+s*13-h,w,h,['#7b8cff','#f5b34a','#2ee6cf','#f87171','#c8cfda'][Math.floor(r()*5)]);bx+=3}}}});
  const plant=(x,y,big)=>draw.push({z:z(x+5,y+5),f:()=>{box(x,y,10,10,8,'#5a4436','#3d2f27','#4a382e');const p=P(x+5,y+5);const h=big?16:10;rect(ctx,p[0]-1,p[1]-8-h,2,h,'#2f7d4a');rect(ctx,p[0]-5,p[1]-13-h,4,7,'#3fa35f');rect(ctx,p[0]+1,p[1]-15-h,4,8,'#3fa35f');rect(ctx,p[0]-2,p[1]-18-h,4,6,'#56c47a')}});plant(340,62,true);plant(88,64,false);plant(W-14,D-14,true);plant(30,D-14,false);
  world.agents.filter(a=>!SEATED.includes(a.state)).forEach(a=>draw.push({z:z(a.x+8,a.y),f:()=>{const p=P(a.x+8,a.y);const kind=a.state==='arcade'?'back':'stand';let flip=a.dir<0;if(a.state==='walk'&&a.vdir==='front'){a._vd='front'}agentSprite(ctx,a,kind,p[0]-8,p[1]-24,flip,t);bubble(ctx,a,p[0]-2,p[1]-31,t);tags.push({x:p[0]*S,y:(p[1]+12)*S,text:a.name,color:a.color});hits.push({id:a.id,x:(p[0]-8)*S,y:(p[1]-26)*S,w:32,h:56});if(a.id===world.focusId){const k=Math.floor(t*4)%2;rect(ctx,p[0]-2,p[1]-38-k,4,2,'#fff');rect(ctx,p[0]-1,p[1]-36-k,2,2,'#fff')}}}));
  const lp=P(440,58);tags.push({x:lp[0]*S,y:(lp[1]-42)*S,text:'LOUNGE',color:'#f5b34a'});
  world.departments.forEach(dp=>{if(dp.row!==1||dp.x1<=dp.x0)return;const p=P((dp.x0+dp.x1)/2,FRONT+22);draw.push({z:z((dp.x0+dp.x1)/2,FRONT+22),f:()=>{poly([P(dp.x0,FRONT+18),P(dp.x1,FRONT+18),P(dp.x1,FRONT+20),P(dp.x0,FRONT+20)],dp.color)}});tags.push({x:p[0]*S,y:(p[1]+14)*S,text:dp.name.toUpperCase(),color:dp.color})});
  draw.sort((p,q)=>p.z-q.z).forEach(o=>o.f());
  ctx.setTransform(1,0,0,1,0,0);ctx.fillStyle='rgba(14,22,58,'+(.42*night).toFixed(3)+')';ctx.fillRect(0,0,CW,CH);if(d>0&&d<.6){ctx.fillStyle='rgba(255,140,80,'+(.08*(1-Math.abs(d-.3)/.3)).toFixed(3)+')';ctx.fillRect(0,0,CW,CH)}
  labelsPx(ctx,tags.filter(x=>x.x>-40&&x.x<CW+40&&x.y>0&&x.y<CH+20));world.ihits=hits;
}
E._c={agentSprite,bubble,windowC,pendant,labelsPx,lerpC,SEATED,arcadeC,coffeeC,vendingC,sofaC,plantC,shelfC,coolerC};
E.WorldC=WorldC;E.renderSideC=renderSideC;E.renderIsoC=renderIsoC;
})();

/* v5: static full-office views, mouse wheel zoom + drag pan, higher-detail furniture, shadows, wood floor */
(function(){
const E=window.OfficeEngine,{rect,drawBoard,screenLines,stars,rnd,shade}=E._h,{agentSprite,bubble,windowC,pendant,labelsPx,lerpC,SEATED,arcadeC,coffeeC,vendingC,sofaC,plantC,shelfC,coolerC}=E._c;
function fit(v,cw,ch){const sw=v.w*v.S,sh=v.h*v.S;v.ox=sw<=cw?(cw-sw)/2:Math.max(cw-sw,Math.min(0,v.ox));v.oy=sh<=ch?(ch-sh)/2:Math.max(ch-sh,Math.min(0,v.oy));v.ox=Math.round(v.ox);v.oy=Math.round(v.oy)}
function shadow(ctx,x,y,w,h,a){ctx.save();ctx.globalAlpha=a||.28;ctx.fillStyle='#000';ctx.fillRect(Math.round(x),Math.round(y),Math.round(w),Math.round(h));ctx.restore()}
function focusMark(ctx,x,y,t){const k=Math.floor(t*4)%2;rect(ctx,x-2,y-k,6,2,'#fff');rect(ctx,x-1,y+2-k,4,2,'#fff');rect(ctx,x,y+4-k,2,1,'#fff')}
function wallD(ctx,W,WALL,d){const top=lerpC('#232a3a','#5a667f',d),bot=lerpC('#1a1f2c','#48536a',d);for(let y=0;y<WALL;y+=2)rect(ctx,0,y,W,2,lerpC(top,bot,y/WALL));for(let x=0;x<W;x+=50)rect(ctx,x,0,1,WALL,'rgba(0,0,0,.07)');
  rect(ctx,0,0,W,3,lerpC('#10141d','#2c3444',d));rect(ctx,0,3,W,1,'rgba(255,255,255,.06)');
  rect(ctx,0,74,W,WALL-74,lerpC('#181d29','#3d475c',d));rect(ctx,0,74,W,2,lerpC('#2a3140','#6a7690',d));for(let x=8;x<W;x+=28){rect(ctx,x,80,20,WALL-88,'rgba(0,0,0,.12)');rect(ctx,x,80,20,1,'rgba(255,255,255,.05)')}
  rect(ctx,0,WALL-6,W,6,lerpC('#2a2f3a','#6a7085',d));rect(ctx,0,WALL-6,W,1,'rgba(255,255,255,.12)');rect(ctx,0,WALL,W,2,'#14171f')}
function floorD(ctx,W,y0,y1,d,seed){const r=rnd(seed);for(let y=y0;y<y1;y+=6){const k=(y-y0)/(y1-y0);rect(ctx,0,y,W,6,lerpC(lerpC('#2c2620','#4a3f35',k),lerpC('#56483c','#80705e',k),d));rect(ctx,0,y,W,1,'rgba(0,0,0,.28)');let x=-Math.floor(r()*60);while(x<W){const len=40+Math.floor(r()*40),v=r();if(v<.3)rect(ctx,x,y+1,len,5,'rgba(255,255,255,.03)');else if(v>.8)rect(ctx,x,y+1,len,5,'rgba(0,0,0,.06)');rect(ctx,x+len,y+1,1,5,'rgba(0,0,0,.25)');x+=len+1}}}
function deskD(ctx,x,fy,a,world,t,seed,night){const st=a?world.status(a):'idle';
  shadow(ctx,x-4,fy-2,62,3,.3);shadow(ctx,x+12,fy-13,46,13,.10);
  rect(ctx,x-2,fy-3,14,2,'#1c1f27');rect(ctx,x-3,fy-2,3,2,'#0d1018');rect(ctx,x+9,fy-2,3,2,'#0d1018');rect(ctx,x+4,fy-10,2,8,'#2a2f3a');rect(ctx,x-1,fy-13,12,4,'#2f3542');rect(ctx,x-1,fy-13,12,1,'#3d4452');rect(ctx,x-2,fy-29,3,17,'#2a2f3a');rect(ctx,x-3,fy-30,10,4,'#2f3542');rect(ctx,x-2,fy-29,8,1,'#3d4452');
  rect(ctx,x+12,fy-19,46,4,'#dccfb8');rect(ctx,x+12,fy-19,46,1,'#f2eadb');rect(ctx,x+12,fy-16,46,1,'#a89b84');rect(ctx,x+14,fy-15,2,15,'#3a3f4a');rect(ctx,x+15,fy-15,1,15,'#4a505c');
  rect(ctx,x+44,fy-15,13,15,'#c9bca4');rect(ctx,x+44,fy-15,13,1,'#a89b84');rect(ctx,x+45,fy-13,11,5,'#d6c9b1');rect(ctx,x+45,fy-7,11,5,'#d6c9b1');rect(ctx,x+49,fy-11,3,1,'#3a3f4a');rect(ctx,x+49,fy-5,3,1,'#3a3f4a');rect(ctx,x+44,fy-1,13,1,'#3a3f4a');
  rect(ctx,x+25,fy-37,21,15,'#1a1d26');rect(ctx,x+26,fy-36,19,13,'#0d1018');screenLines(ctx,x+27,fy-35,17,11,st,t,seed);rect(ctx,x+26,fy-36,19,1,'#2a2f3a');rect(ctx,x+34,fy-22,3,3,'#1a1d26');rect(ctx,x+30,fy-20,11,1,'#1a1d26');rect(ctx,x+35,fy-19,1,4,'#14171f');
  rect(ctx,x+16,fy-21,12,2,'#262b36');for(let i=0;i<5;i++)rect(ctx,x+17+i*2,fy-21,1,1,'#3d4452');rect(ctx,x+30,fy-21,3,2,'#c8cfda');
  const prop=seed%3;if(prop===0){rect(ctx,x+48,fy-24,5,5,['#e7eaf0','#f5b34a','#7b8cff'][seed%3]);rect(ctx,x+53,fy-23,1,3,'#e7eaf0');rect(ctx,x+49,fy-26+(Math.floor(t*2)%2),1,1,'rgba(255,255,255,.4)')}
  else if(prop===1){rect(ctx,x+48,fy-25,6,6,'#3d2f27');rect(ctx,x+49,fy-25,4,1,'#5a4436');rect(ctx,x+50,fy-30,2,5,'#2f7d4a');rect(ctx,x+47,fy-29,3,3,'#3fa35f');rect(ctx,x+52,fy-31,3,3,'#56c47a')}
  else{rect(ctx,x+47,fy-22,8,3,'#e7eaf0');rect(ctx,x+48,fy-23,6,1,'#c8cfda');rect(ctx,x+49,fy-21,4,1,'#8a929e')}
  rect(ctx,x+19,fy-38,1,19,'#3a3f4a');rect(ctx,x+16,fy-40,8,3,'#3a3f4a');rect(ctx,x+17,fy-37,6,1,'#f5e2b0');
  if(night>.15&&st!=='paused'){ctx.save();ctx.globalAlpha=.30*night;ctx.fillStyle='#ffd88a';ctx.beginPath();ctx.moveTo(x+16,fy-37);ctx.lineTo(x+24,fy-37);ctx.lineTo(x+30,fy-19);ctx.lineTo(x+10,fy-19);ctx.closePath();ctx.fill();ctx.globalAlpha=.16*night;ctx.fillStyle=E.STATUS[st]||'#2ee6cf';ctx.fillRect(x+18,fy-40,34,24);ctx.restore()}}

function renderSideD(ctx,world){
  const cv=ctx.canvas,CW=cv.width,CH=cv.height,W=world.W,WALL=100,H=236,t=world.t,d=world.daylight(),night=1-d;
  const v=world.view||(world.view={S:2,ox:0,oy:0,w:W,h:H,levels:[2,3,4,6]});fit(v,CW,CH);const S=v.S,sx=x=>v.ox+x*S,sy=y=>v.oy+y*S;
  ctx.setTransform(1,0,0,1,0,0);ctx.fillStyle='#07080b';ctx.fillRect(0,0,CW,CH);ctx.setTransform(S,0,0,S,v.ox,v.oy);const tags=[],hits=[];
  wallD(ctx,W,WALL,d);floorD(ctx,W,WALL+2,H,d,5);
  for(let x=60;x<W;x+=88)pendant(ctx,x,10,night);
  windowC(ctx,132,14,58,52,world,11);windowC(ctx,300,14,58,52,world,23);windowC(ctx,440,14,56,52,world,31);
  rect(ctx,100,18,14,14,'#e8e2d6');rect(ctx,101,19,12,12,'#0d1018');rect(ctx,102,20,10,10,'#f4f1ea');{const cx=107,cy=25,ha=(world.hour%12)/12*Math.PI*2-Math.PI/2,ma=(world.hour%1)*Math.PI*2-Math.PI/2;ctx.strokeStyle='#1a1c24';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(cx,cy);ctx.lineTo(cx+Math.cos(ha)*3,cy+Math.sin(ha)*3);ctx.stroke();ctx.beginPath();ctx.moveTo(cx,cy);ctx.lineTo(cx+Math.cos(ma)*4.5,cy+Math.sin(ma)*4.5);ctx.stroke()}
  [[200,18],[228,18],[256,18],[372,18],[400,18]].forEach(([x,y],i)=>{shadow(ctx,x+1,y+1,22,30,.2);rect(ctx,x,y,22,30,'#e8e2d6');rect(ctx,x+1,y+1,20,28,['#1d2a3a','#2a1e30','#1e2a24','#2a2418','#1a2230'][i]);rect(ctx,x+4,y+6,14,3,['#2ee6cf','#c084fc','#4ade80','#f5b34a','#7b8cff'][i]);rect(ctx,x+4,y+12,10,2,'#c8cfda');rect(ctx,x+4,y+16,14,2,'#c8cfda');rect(ctx,x+4,y+20,7,2,'#c8cfda')});
  shadow(ctx,11,13,74,56,.2);drawBoard(ctx,world,10,12,74,56);tags.push({x:sx(47),y:sy(12)-2,text:'TASK BOARD',color:'#2ee6cf'});
  world.departments.forEach(dp=>{if(dp.row!==0||dp.x1<=dp.x0)return;const w=dp.x1-dp.x0;rect(ctx,dp.x0+6,78,w-12,10,'#14171f');rect(ctx,dp.x0+7,79,w-14,8,'#1c2230');rect(ctx,dp.x0+8,86,w-16,1,dp.color);tags.push({x:sx((dp.x0+dp.x1)/2),y:sy(87)-1,text:dp.name.toUpperCase(),color:dp.color})});
  rect(ctx,392,78,60,10,'#14171f');rect(ctx,393,79,58,8,'#1c2230');rect(ctx,394,86,56,1,'#f5b34a');tags.push({x:sx(422),y:sy(87)-1,text:'LOUNGE',color:'#f5b34a'});
  if(d>.05){ctx.save();ctx.globalAlpha=.10*d;ctx.fillStyle='#ffe9b0';[[132,58],[300,58],[440,56]].forEach(([x,w])=>{ctx.beginPath();ctx.moveTo(x,66);ctx.lineTo(x+w,66);ctx.lineTo(x+w+26,H);ctx.lineTo(x-14,H);ctx.closePath();ctx.fill()});ctx.restore()}
  const LF=160;shadow(ctx,384,LF-6,116,30,.12);rect(ctx,384,LF-4,116,26,'#4a3a48');rect(ctx,386,LF-2,112,22,'#3a2b3f');for(let i=0;i<5;i++)rect(ctx,390+i*22,LF+2,12,14,'#4a3652');
  [[360,24],[400,18],[428,20],[452,16],[474,34],[486,10]].forEach(([x,w])=>shadow(ctx,x-1,LF-3,w+2,2,.3));
  shelfC(ctx,360,LF-2);arcadeC(ctx,world.arcadePos.x,LF-2,t,night);coffeeC(ctx,world.coffeePos.x,LF-2,t);vendingC(ctx,world.vendingPos.x,LF-2,t);sofaC(ctx,world.sofaPos.x,LF-2);coolerC(ctx,486,LF-6,t);plantC(ctx,340,LF,t,true);plantC(ctx,88,LF+4,t,false);
  const items=[],BFY=126,FFY=214,corrY=y=>BFY+(y-30)*((FFY-BFY)/110);
  world.desks.forEach((dk,i)=>{const fy=dk.row===0?BFY:FFY,a=dk.agent,seated=SEATED.includes(a.state);items.push({z:fy-1,f:()=>{deskD(ctx,dk.x,fy,a,world,t,i+1,night);
    if(seated){if(a.state==='blocked'){agentSprite(ctx,a,'stand',dk.x+1,fy-24,false,t);bubble(ctx,a,dk.x+6,fy-32,t)}else{agentSprite(ctx,a,'sit',dk.x+2,fy-24,false,t);bubble(ctx,a,dk.x+6,fy-31,t)}
      tags.push({x:sx(dk.x+9),y:sy(fy)+13,text:a.name,color:a.color});hits.push({id:a.id,x:sx(dk.x-3),y:sy(fy-30),w:20*S,h:32*S});if(a.id===world.focusId)focusMark(ctx,dk.x+8,fy-42,t)}}})});
  world.agents.filter(a=>!SEATED.includes(a.state)).forEach(a=>{const fy=Math.round(corrY(Math.max(30,Math.min(140,a.y))));items.push({z:fy+.5,f:()=>{shadow(ctx,a.x+2,fy-1,12,2,.3);agentSprite(ctx,a,a.state==='arcade'?'back':'stand',a.x,fy-24,a.dir<0,t);bubble(ctx,a,a.x+6,fy-31,t);
    tags.push({x:sx(a.x+8),y:sy(fy)+13,text:a.name,color:a.color});hits.push({id:a.id,x:sx(a.x),y:sy(fy-26),w:16*S,h:28*S});if(a.id===world.focusId)focusMark(ctx,a.x+6,fy-38,t)}})});
  items.sort((p,q)=>p.z-q.z).forEach(o=>o.f());
  world.departments.forEach(dp=>{if(dp.row!==1||dp.x1<=dp.x0)return;rect(ctx,dp.x0-2,FFY+4,dp.x1-dp.x0+4,1,dp.color);tags.push({x:sx((dp.x0+dp.x1)/2),y:sy(FFY+16),text:dp.name.toUpperCase(),color:dp.color})});
  ctx.setTransform(1,0,0,1,0,0);ctx.fillStyle='rgba(14,22,58,'+(.42*night).toFixed(3)+')';ctx.fillRect(0,0,CW,CH);if(d>0&&d<.6){ctx.fillStyle='rgba(255,140,80,'+(.08*(1-Math.abs(d-.3)/.3)).toFixed(3)+')';ctx.fillRect(0,0,CW,CH)}
  labelsPx(ctx,tags.filter(x=>x.x>-40&&x.x<CW+40&&x.y>0&&x.y<CH+20));world.hitsD=hits;
}

function renderIsoD(ctx,world){
  const cv=ctx.canvas,CW=cv.width,CH=cv.height,W=world.W,D=world.D,t=world.t,d=world.daylight(),night=1-d,wallH=64;
  const v=world.iview||(world.iview={S:2,ox:0,oy:0,w:W+D+4,h:(W+D)/2+wallH+14,levels:[2,3,4]});fit(v,CW,CH);const S=v.S,sx=x=>v.ox+x*S,sy=y=>v.oy+y*S;
  ctx.setTransform(1,0,0,1,0,0);ctx.fillStyle='#07080b';ctx.fillRect(0,0,CW,CH);ctx.setTransform(S,0,0,S,v.ox,v.oy);const tags=[],hits=[];
  const P=(x,y)=>[Math.round(x-y+D+2),Math.round((x+y)/2+wallH+8)];
  const poly=(pts,col)=>{ctx.fillStyle=col;ctx.beginPath();pts.forEach((p,i)=>i?ctx.lineTo(p[0],p[1]):ctx.moveTo(p[0],p[1]));ctx.closePath();ctx.fill()};
  const spoly=(pts,a)=>{ctx.save();ctx.globalAlpha=a;poly(pts,'#000');ctx.restore()};
  const box=(x,y,w,dd,h,top,l,r,sh)=>{if(sh!==false)spoly([P(x+2,y+2),P(x+w+4,y+2),P(x+w+4,y+dd+3),P(x+2,y+dd+3)],.22);const p1=P(x,y),p2=P(x+w,y),p3=P(x+w,y+dd),p4=P(x,y+dd);const up=p=>[p[0],p[1]-h];poly([up(p1),up(p2),up(p3),up(p4)],top);poly([up(p4),up(p3),p3,p4],l);poly([up(p3),up(p2),p2,p3],r);ctx.strokeStyle='rgba(255,255,255,.14)';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(up(p4)[0],up(p4)[1]+.5);ctx.lineTo(up(p3)[0],up(p3)[1]+.5);ctx.lineTo(up(p2)[0],up(p2)[1]+.5);ctx.stroke()};
  const A=P(0,0),B=P(W,0),C=P(0,D);
  poly([[A[0],A[1]-wallH],[B[0],B[1]-wallH],B,A],lerpC('#1e2433','#4b5670',d));poly([[A[0],A[1]-wallH],[C[0],C[1]-wallH],C,A],lerpC('#161b28','#3a4358',d));poly([[A[0],A[1]-wallH-3],[B[0],B[1]-wallH-3],[B[0],B[1]-wallH],[A[0],A[1]-wallH]],'#12151f');
  poly([[A[0],A[1]-6],[B[0],B[1]-6],B,A],lerpC('#2a2f3a','#6a7085',d));poly([[A[0],A[1]-6],[C[0],C[1]-6],C,A],lerpC('#242935','#5a6075',d));
  const fr=rnd(3);for(let i=0;i<W/20;i++)for(let j=0;j<D/20;j++){const x=i*20,y=j*20,vv=fr();const lounge=y>=60&&y<120&&x>=380;const base=lounge?((i+j)%2?'#3a2b3f':'#432f47'):((i+j)%2?'#3d342c':'#46392f');const c=lerpC(base,shade(base,1.5),d*.5);poly([P(x,y),P(x+20,y),P(x+20,y+20),P(x,y+20)],vv<.25?shade(c,.94):vv>.8?shade(c,1.05):c);ctx.strokeStyle='rgba(0,0,0,.18)';ctx.beginPath();const q=P(x,y+20),q2=P(x+20,y+20),q3=P(x+20,y);ctx.moveTo(q[0],q[1]+.5);ctx.lineTo(q2[0],q2[1]+.5);ctx.lineTo(q3[0],q3[1]+.5);ctx.stroke()}
  for(let i=0;i<W/20;i++)poly([P(i*20,80),P(i*20+20,80),P(i*20+20,100),P(i*20,100)],i%2?'#2d3142':'#30344a');
  poly([P(384,62),P(500,62),P(500,118),P(384,118)],'#4a3a48');poly([P(388,66),P(496,66),P(496,114),P(388,114)],'#3a2b3f');
  ctx.save();ctx.setTransform(S,S*.5,0,S,v.ox+A[0]*S,v.oy+(A[1]-wallH)*S);
  drawBoard(ctx,world,10,8,74,50);windowC(ctx,132,10,58,44,world,11);windowC(ctx,300,10,58,44,world,23);windowC(ctx,440,10,56,44,world,31);
  rect(ctx,100,12,14,14,'#e8e2d6');rect(ctx,101,13,12,12,'#0d1018');rect(ctx,102,14,10,10,'#f4f1ea');[[200,12],[228,12],[256,12],[372,12]].forEach(([x,y],i)=>{rect(ctx,x,y,22,30,'#e8e2d6');rect(ctx,x+1,y+1,20,28,['#1d2a3a','#2a1e30','#1e2a24','#2a2418'][i]);rect(ctx,x+4,y+6,14,3,['#2ee6cf','#c084fc','#4ade80','#f5b34a'][i]);rect(ctx,x+4,y+12,10,2,'#c8cfda');rect(ctx,x+4,y+16,14,2,'#c8cfda')});
  world.departments.forEach(dp=>{if(dp.row!==0||dp.x1<=dp.x0)return;const w=dp.x1-dp.x0;rect(ctx,dp.x0+6,52,w-12,9,'#14171f');rect(ctx,dp.x0+7,53,w-14,7,'#1c2230');rect(ctx,dp.x0+8,59,w-16,1,dp.color);const wx=(dp.x0+dp.x1)/2;tags.push({x:sx(A[0]+wx),y:sy(A[1]-wallH+wx*.5+66),text:dp.name.toUpperCase(),color:dp.color})});ctx.restore();
  if(d>.05){ctx.save();ctx.globalAlpha=.10*d;[[132,58],[300,58],[440,56]].forEach(([x,w])=>poly([P(x,0),P(x+w,0),P(x+w+30,70),P(x-10,70)],'#ffe9b0'));ctx.restore()}
  const draw=[],z=(x,y)=>x+y;
  world.desks.forEach((dk,i)=>{const a=dk.agent,st=world.status(a),seated=SEATED.includes(a.state);
    draw.push({z:z(dk.x+30,dk.y-4),f:()=>{box(dk.x+10,dk.y-10,44,14,16,'#e2d9c8','#b3a892','#cfc5b2');const dr=P(dk.x+54,dk.y-2);rect(ctx,dr[0]-6,dr[1]-9,5,1,'#3a3f4a');rect(ctx,dr[0]-6,dr[1]-4,5,1,'#3a3f4a');const m=P(dk.x+34,dk.y-8);rect(ctx,m[0]-9,m[1]-30,19,14,'#14171f');rect(ctx,m[0]-8,m[1]-29,17,12,'#0d1018');screenLines(ctx,m[0]-7,m[1]-28,15,10,st,t,i*13);rect(ctx,m[0]-8,m[1]-29,17,1,'#2a2f3a');rect(ctx,m[0]-1,m[1]-16,3,2,'#14171f');rect(ctx,m[0]-4,m[1]-14,9,1,'#14171f');const k=P(dk.x+22,dk.y-2);rect(ctx,k[0]-5,k[1]-17,10,2,'#20242f');for(let q=0;q<4;q++)rect(ctx,k[0]-4+q*2,k[1]-17,1,1,'#3d4452');rect(ctx,k[0]+7,k[1]-17,2,2,'#c8cfda');const g=P(dk.x+48,dk.y-6);rect(ctx,g[0],g[1]-22,4,5,['#e7eaf0','#f5b34a','#7b8cff'][i%3]);if(i%2){const pl=P(dk.x+16,dk.y-6);rect(ctx,pl[0],pl[1]-23,4,5,'#3d2f27');rect(ctx,pl[0]+1,pl[1]-27,3,4,'#3fa35f');rect(ctx,pl[0]-1,pl[1]-26,2,2,'#56c47a')}
      const lp=P(dk.x+18,dk.y-8);rect(ctx,lp[0],lp[1]-36,1,18,'#3a3f4a');rect(ctx,lp[0]-3,lp[1]-38,8,3,'#3a3f4a');rect(ctx,lp[0]-2,lp[1]-35,6,1,'#f5e2b0');
      if(night>.15&&st!=='paused'){ctx.save();ctx.globalAlpha=.16*night;ctx.fillStyle=E.STATUS[st]||'#2ee6cf';ctx.fillRect(m[0]-18,m[1]-34,40,26);ctx.globalAlpha=.22*night;ctx.fillStyle='#ffd88a';ctx.fillRect(lp[0]-5,lp[1]-34,12,16);ctx.restore()}}});
    draw.push({z:z(dk.x+4,dk.y+10),f:()=>{const ch=P(dk.x+4,dk.y+10);spoly([P(dk.x-2,dk.y+4),P(dk.x+12,dk.y+4),P(dk.x+12,dk.y+18),P(dk.x-2,dk.y+18)],.2);rect(ctx,ch[0]-6,ch[1]-8,12,3,'#2a2f3a');rect(ctx,ch[0]-6,ch[1]-8,12,1,'#3d4452');rect(ctx,ch[0]-6,ch[1]-26,2,18,'#1c1f27');rect(ctx,ch[0]-7,ch[1]-29,9,4,'#2a2f3a');rect(ctx,ch[0]-6,ch[1]-29,7,1,'#3d4452');rect(ctx,ch[0]-1,ch[1]-5,2,4,'#1c1f27');rect(ctx,ch[0]-6,ch[1]-1,12,1,'#1c1f27');
      if(seated){const p=P(dk.x+6,dk.y+8);if(a.state==='blocked')agentSprite(ctx,a,'stand',p[0]-6,p[1]-26,false,t);else agentSprite(ctx,a,'sit',p[0]-6,p[1]-24,false,t);bubble(ctx,a,p[0]-2,p[1]-32,t);tags.push({x:sx(p[0]),y:sy(p[1]+12),text:a.name,color:a.color});hits.push({id:a.id,x:sx(p[0]-8),y:sy(p[1]-26),w:16*S,h:28*S});if(a.id===world.focusId)focusMark(ctx,p[0]-2,p[1]-40,t)}}})});
  const ap=world.arcadePos;draw.push({z:z(ap.x+9,ap.y-4),f:()=>{box(ap.x,ap.y-12,18,12,38,'#2a2340','#1a1530','#221c38');const p=P(ap.x+18,ap.y-2);rect(ctx,p[0]-8,p[1]-38,12,4,'#c084fc');rect(ctx,p[0]-7,p[1]-33,10,8,'#0a0c10');const r=rnd(Math.floor(t*5));for(let i=0;i<5;i++)rect(ctx,p[0]-6+Math.floor(r()*8),p[1]-32+Math.floor(r()*6),1,1,['#2ee6cf','#f5b34a','#fff'][i%3]);rect(ctx,p[0]-7,p[1]-23,10,4,'#3a3050');rect(ctx,p[0]-5,p[1]-22,1,1,'#f87171');rect(ctx,p[0]-1,p[1]-22,1,1,'#2ee6cf');if(night>.1){ctx.save();ctx.globalAlpha=.22*night;ctx.fillStyle='#c084fc';ctx.fillRect(p[0]-14,p[1]-44,26,48);ctx.restore()}}});
  const cp=world.coffeePos;draw.push({z:z(cp.x+10,cp.y-4),f:()=>{box(cp.x,cp.y-12,20,12,26,'#3a4150','#20262f','#2a3040');const p=P(cp.x+20,cp.y-2);rect(ctx,p[0]-6,p[1]-24,8,5,'#0b1f24');rect(ctx,p[0]-5,p[1]-23,Math.floor(t*4)%6,1,'#2ee6cf');rect(ctx,p[0]-3,p[1]-11,4,4,'#e7eaf0');rect(ctx,p[0]-2+Math.floor(t*3)%2,p[1]-15,1,3,'#8a929e')}});
  const vp=world.vendingPos;draw.push({z:z(vp.x+8,vp.y-4),f:()=>{box(vp.x,vp.y-12,16,12,34,'#1d2a3a','#101a26','#162230');const p=P(vp.x+16,vp.y-2);for(let r=0;r<5;r++)for(let c=0;c<3;c++)rect(ctx,p[0]-7+c*2,p[1]-32+r*4,1,3,['#f87171','#f5b34a','#4ade80','#7b8cff','#2ee6cf'][(r+c)%5]);rect(ctx,p[0]+1,p[1]-32,2,12,Math.floor(t*2)%2?'#2ee6cf':'#1a5f66')}});
  const sp=world.sofaPos;draw.push({z:z(sp.x+17,sp.y+5),f:()=>{box(sp.x,sp.y,34,12,7,'#4a3652','#2f2436','#3a2b3f');box(sp.x,sp.y-2,34,3,14,'#3a2b3f','#2a1e30','#33263a',false);const p=P(sp.x+10,sp.y+6);rect(ctx,p[0]-3,p[1]-12,6,4,'#f5b34a');const q=P(sp.x+24,sp.y+6);rect(ctx,q[0]-3,q[1]-12,6,4,'#2ee6cf')}});
  draw.push({z:z(372,66),f:()=>{box(360,60,24,8,42,'#5a4436','#3d2f27','#4a382e');const p=P(384,64);for(let s=0;s<3;s++){rect(ctx,p[0]-10,p[1]-40+s*13,16,1,'#3d2f27');const r=rnd(s);let bx=p[0]-9;while(bx<p[0]+4){const h=6+Math.floor(r()*4);rect(ctx,bx,p[1]-40+s*13-h,2,h,['#7b8cff','#f5b34a','#2ee6cf','#f87171','#c8cfda'][Math.floor(r()*5)]);bx+=3}}}});
  draw.push({z:z(490,64),f:()=>{box(486,58,8,8,28,'#c8cfda','#9aa3b0','#b3bcc8');const p=P(494,62);rect(ctx,p[0]-4,p[1]-40,7,12,'#9ecfea');rect(ctx,p[0]-3,p[1]-39,5,10,'#bfe3f5');rect(ctx,p[0]-3,p[1]-39,5,Math.floor(t*2)%3,'#9ecfea');rect(ctx,p[0]-1,p[1]-20,2,2,'#2ee6cf')}});
  const plant=(x,y,big)=>draw.push({z:z(x+5,y+5),f:()=>{box(x,y,10,10,8,'#5a4436','#3d2f27','#4a382e');const p=P(x+5,y+5),h=big?16:10,sw=Math.round(Math.sin(t*1.5+x));rect(ctx,p[0]-1,p[1]-8-h,2,h,'#2f7d4a');rect(ctx,p[0]-5+sw,p[1]-13-h,4,7,'#3fa35f');rect(ctx,p[0]+1-sw,p[1]-15-h,4,8,'#3fa35f');rect(ctx,p[0]-2,p[1]-18-h,4,6,'#56c47a')}});plant(340,62,true);plant(88,64,false);plant(W-14,D-14,true);plant(30,D-14,false);
  world.agents.filter(a=>!SEATED.includes(a.state)).forEach(a=>draw.push({z:z(a.x+8,a.y),f:()=>{const p=P(a.x+8,a.y);spoly([P(a.x+3,a.y-4),P(a.x+13,a.y-4),P(a.x+13,a.y+4),P(a.x+3,a.y+4)],.25);agentSprite(ctx,a,a.state==='arcade'?'back':'stand',p[0]-8,p[1]-24,a.dir<0,t);bubble(ctx,a,p[0]-2,p[1]-31,t);tags.push({x:sx(p[0]),y:sy(p[1]+12),text:a.name,color:a.color});hits.push({id:a.id,x:sx(p[0]-8),y:sy(p[1]-26),w:16*S,h:28*S});if(a.id===world.focusId)focusMark(ctx,p[0]-2,p[1]-40,t)}}));
  const lp=P(440,58);tags.push({x:sx(lp[0]),y:sy(lp[1]-42),text:'LOUNGE',color:'#f5b34a'});
  world.departments.forEach(dp=>{if(dp.row!==1||dp.x1<=dp.x0)return;const p=P((dp.x0+dp.x1)/2,140+22);draw.push({z:z((dp.x0+dp.x1)/2,162),f:()=>poly([P(dp.x0,158),P(dp.x1,158),P(dp.x1,160),P(dp.x0,160)],dp.color)});tags.push({x:sx(p[0]),y:sy(p[1]+14),text:dp.name.toUpperCase(),color:dp.color})});
  draw.sort((p,q)=>p.z-q.z).forEach(o=>o.f());
  ctx.setTransform(1,0,0,1,0,0);ctx.fillStyle='rgba(14,22,58,'+(.42*night).toFixed(3)+')';ctx.fillRect(0,0,CW,CH);if(d>0&&d<.6){ctx.fillStyle='rgba(255,140,80,'+(.08*(1-Math.abs(d-.3)/.3)).toFixed(3)+')';ctx.fillRect(0,0,CW,CH)}
  labelsPx(ctx,tags.filter(x=>x.x>-40&&x.x<CW+40&&x.y>0&&x.y<CH+20));world.ihitsD=hits;
}
E.renderSideD=renderSideD;E.renderIsoD=renderIsoD;

/* v6: pod layout — 8 departments × 4 desks as 2×2 islands in two bands around a central corridor; lounge wing on the right */
const PX=[70,210,350,490],BANDS=[[44,100],[196,252]],CORR=148;
class WorldD extends E.World{
  constructor(cfg){super({departments:cfg.departments});this.W=720;this.D=310;this.hour=9;this.focusId=null;this.agents.forEach((a,i)=>a.lookIdx=i);
    this.boardPos={x:10,y:14};this.arcadePos={x:626,y:44};this.coffeePos={x:652,y:44};this.vendingPos={x:678,y:44};this.sofaPos={x:640,y:96};
    this.layout={corridor:[136,160],lounge:{x0:610,y0:30,x1:720,y1:130},windows:[132,300,440,580],shelf:{x:696,y:80},cooler:{x:612,y:38},plants:[[20,290,true],[700,290,true],[20,20,false],[600,290,false],[340,136,false]]};
    this.desks=[];this.departments.forEach((d,i)=>{const px=PX[i%4],band=BANDS[Math.floor(i/4)%2];d.band=Math.floor(i/4)%2;d.x0=px-6;d.x1=px+120;d.y0=band[0]-16;d.y1=band[1]+14;
      this.agents.filter(a=>a.dept===i).forEach((a,j)=>{const x=px+(j%2)*60,y=band[Math.floor(j/2)];a.deskIdx=this.desks.length;this.desks.push({x,y,dept:i,agent:a});a.x=x+2;a.y=y})})}
  aisle(x){const lg=this.layout.lounge;if(x>=lg.x0-10)return lg.x0-14;let ax=40;for(const p of (this.PX||PX))if(x>=p-20)ax=p-18;return ax}
  goTo(a,t,next){const a1=this.aisle(a.x),a2=this.aisle(t.x),p=[];if(Math.abs(a.y-CORR)>4){p.push({x:a1,y:a.y});p.push({x:a1,y:CORR})}p.push({x:a2,y:CORR});if(Math.abs(t.y-CORR)>4)p.push({x:a2,y:t.y});p.push({x:t.x,y:t.y});a.path=p;a.state='walk';a.next=next}
  seat(a){const d=this.desks[a.deskIdx];return{x:d.x+2,y:d.y}}
  boardTarget(){return{x:44,y:26}}
  coffeeTarget(){return{x:this.coffeePos.x-12,y:this.coffeePos.y+16}}
  arcadeTarget(){return{x:this.arcadePos.x+2,y:this.arcadePos.y+16}}
  tick(dt){super.tick(dt);this.hour=(4+(this.t/150)*24)%24}
  daylight(){return Math.max(0,Math.sin((this.hour-6)/12*Math.PI))}
  clock(){const h=Math.floor(this.hour),m=Math.floor((this.hour%1)*60);return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')}
}
function renderIsoE(ctx,world,opts){opts=opts||{};
  const cv=ctx.canvas,CW=cv.width,CH=cv.height,W=world.W,D=world.D,t=world.t,TD=opts.tod?E.tod(world.hour):null,d=TD?TD.light:world.daylight(),night=1-d,wallH=64,L=world.layout,winF=TD?windowE:windowC;
  const vk=opts.viewKey||'view6';const v=world[vk]||(world[vk]={S:1,ox:0,oy:0,w:W+D+4,h:(W+D)/2+wallH+14,levels:[1,2,3],li:0});
  if(opts.autofit){const S0=Math.max(.2,Math.min(CW/v.w,CH/v.h));if(v.base!==S0){const cx=CW/2,cy=CH/2,old=v.S;v.base=S0;v.levels=[1,2,3,4].map(m=>+(m*S0).toFixed(4));v.S=v.levels[v.li||0];if(old){v.ox=Math.round(cx-(cx-v.ox)*v.S/old);v.oy=Math.round(cy-(cy-v.oy)*v.S/old)}}}
  fit(v,CW,CH);const S=v.S,sx=x=>v.ox+x*S,sy=y=>v.oy+y*S;
  ctx.setTransform(1,0,0,1,0,0);ctx.fillStyle='#07080b';ctx.fillRect(0,0,CW,CH);ctx.setTransform(S,0,0,S,v.ox,v.oy);const tags=[],hits=[];
  const P=(x,y)=>[Math.round(x-y+D+2),Math.round((x+y)/2+wallH+8)];
  const poly=(pts,col)=>{ctx.fillStyle=col;ctx.beginPath();pts.forEach((p,i)=>i?ctx.lineTo(p[0],p[1]):ctx.moveTo(p[0],p[1]));ctx.closePath();ctx.fill()};
  const spoly=(pts,a)=>{ctx.save();ctx.globalAlpha=a;poly(pts,'#000');ctx.restore()};
  const box=(x,y,w,dd,h,top,l,r,sh)=>{if(sh!==false)spoly([P(x+2,y+2),P(x+w+4,y+2),P(x+w+4,y+dd+3),P(x+2,y+dd+3)],.22);const p1=P(x,y),p2=P(x+w,y),p3=P(x+w,y+dd),p4=P(x,y+dd);const up=p=>[p[0],p[1]-h];poly([up(p1),up(p2),up(p3),up(p4)],top);poly([up(p4),up(p3),p3,p4],l);poly([up(p3),up(p2),p2,p3],r);ctx.strokeStyle='rgba(255,255,255,.14)';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(up(p4)[0],up(p4)[1]+.5);ctx.lineTo(up(p3)[0],up(p3)[1]+.5);ctx.lineTo(up(p2)[0],up(p2)[1]+.5);ctx.stroke()};
  const A=P(0,0),B=P(W,0),C=P(0,D);
  poly([[A[0],A[1]-wallH],[B[0],B[1]-wallH],B,A],lerpC('#1e2433','#4b5670',d));poly([[A[0],A[1]-wallH],[C[0],C[1]-wallH],C,A],lerpC('#161b28','#3a4358',d));poly([[A[0],A[1]-wallH-3],[B[0],B[1]-wallH-3],[B[0],B[1]-wallH],[A[0],A[1]-wallH]],'#12151f');
  poly([[A[0],A[1]-6],[B[0],B[1]-6],B,A],lerpC('#2a2f3a','#6a7085',d));poly([[A[0],A[1]-6],[C[0],C[1]-6],C,A],lerpC('#242935','#5a6075',d));
  const fr=rnd(3),lg=L.lounge;for(let i=0;i<W/20;i++)for(let j=0;j<D/20;j++){const x=i*20,y=j*20,vv=fr();const lounge=x>=lg.x0&&x<lg.x1&&y>=lg.y0&&y<lg.y1;const base=lounge?((i+j)%2?'#3a2b3f':'#432f47'):((i+j)%2?'#3d342c':'#46392f');const c=lerpC(base,shade(base,1.5),d*.5);poly([P(x,y),P(x+20,y),P(x+20,y+20),P(x,y+20)],vv<.25?shade(c,.94):vv>.8?shade(c,1.05):c);ctx.strokeStyle='rgba(0,0,0,.18)';ctx.beginPath();const q=P(x,y+20),q2=P(x+20,y+20),q3=P(x+20,y);ctx.moveTo(q[0],q[1]+.5);ctx.lineTo(q2[0],q2[1]+.5);ctx.lineTo(q3[0],q3[1]+.5);ctx.stroke()}
  for(let i=0;i<W/20;i++)poly([P(i*20,L.corridor[0]),P(i*20+20,L.corridor[0]),P(i*20+20,L.corridor[1]),P(i*20,L.corridor[1])],i%2?'#2d3142':'#30344a');
  (world.PX||PX).forEach(px=>{for(let j=0;j<D/20;j++)poly([P(px-26,j*20),P(px-10,j*20),P(px-10,j*20+20),P(px-26,j*20+20)],j%2?'#2d3142':'#30344a')});
  world.departments.forEach(dp=>{poly([P(dp.x0,dp.y0),P(dp.x1,dp.y0),P(dp.x1,dp.y1),P(dp.x0,dp.y1)],'rgba(0,0,0,.10)');poly([P(dp.x0,dp.y1-2),P(dp.x1,dp.y1-2),P(dp.x1,dp.y1),P(dp.x0,dp.y1)],dp.color)});
  poly([P(lg.x0+4,lg.y0+24),P(lg.x1-4,lg.y0+24),P(lg.x1-4,lg.y1-6),P(lg.x0+4,lg.y1-6)],'#4a3a48');poly([P(lg.x0+8,lg.y0+28),P(lg.x1-8,lg.y0+28),P(lg.x1-8,lg.y1-10),P(lg.x0+8,lg.y1-10)],'#3a2b3f');
  ctx.save();ctx.setTransform(S,S*.5,0,S,v.ox+A[0]*S,v.oy+(A[1]-wallH)*S);
  drawBoard(ctx,world,10,8,74,50);L.windows.forEach((wx,i)=>winF(ctx,wx,10,58,44,world,11+i*12));
  rect(ctx,100,12,14,14,'#e8e2d6');rect(ctx,101,13,12,12,'#0d1018');rect(ctx,102,14,10,10,'#f4f1ea');[[200,12],[228,12],[256,12],[372,12],[400,12],[512,12],[540,12]].forEach(([x,y],i)=>{if(x>lg.x0-40)return;rect(ctx,x,y,22,30,'#e8e2d6');rect(ctx,x+1,y+1,20,28,['#1d2a3a','#2a1e30','#1e2a24','#2a2418','#1a2230','#2a1e30','#1e2a24'][i]);rect(ctx,x+4,y+6,14,3,['#2ee6cf','#c084fc','#4ade80','#f5b34a','#7b8cff','#fb7185','#4ade80'][i]);rect(ctx,x+4,y+12,10,2,'#c8cfda');rect(ctx,x+4,y+16,14,2,'#c8cfda')});
  rect(ctx,lg.x0+20,52,60,9,'#14171f');rect(ctx,lg.x0+21,53,58,7,'#1c2230');rect(ctx,lg.x0+22,59,56,1,'#f5b34a');tags.push({x:sx(A[0]+lg.x0+50),y:sy(A[1]-wallH+(lg.x0+50)*.5+66),text:'LOUNGE',color:'#f5b34a'});if(opts.fun){neonS(ctx,lg.x0+8,26,t,night);lightsS(ctx,lg.x0-30,W-4,44,t,night);if(lg.x0>300)neonS(ctx,214,40,t,night)}ctx.restore();
  if(d>.05){ctx.save();ctx.globalAlpha=.12*d;L.windows.forEach(x=>poly([P(x,0),P(x+58,0),P(x+88,70),P(x-10,70)],TD?TD.horizon:'#ffe9b0'));ctx.restore()}
  const draw=[],z=(x,y)=>x+y;
  if(opts.partitions)world.departments.forEach(dp=>{const gl='rgba(140,205,225,.38)',gd='rgba(190,230,245,.85)';const x0=dp.x0-6,x1=dp.x1+6,y0=dp.y0-4,y1=dp.y1+2,PH=26;const wallX=(y,x)=>{const p1=P(x,y),p2=P(x,y+30>y1?y1:y+30);poly([[p1[0],p1[1]-PH],[p2[0],p2[1]-PH],p2,p1],gl);rect(ctx,p1[0],p1[1]-PH,1,PH,gd);rect(ctx,p1[0],p1[1]-PH,p2[0]-p1[0],1,gd)};const wallY=(x,y)=>{const p1=P(x,y),p2=P(x+30>x1?x1:x+30,y);poly([[p1[0],p1[1]-PH],[p2[0],p2[1]-PH],p2,p1],gl);rect(ctx,p2[0],p2[1]-PH,1,PH,gd);rect(ctx,p1[0],p1[1]-PH,p2[0]-p1[0],1,gd)};
    for(let x=x0;x<x1;x+=30)draw.push({z:z(x+15,y0)-1,f:()=>wallY(x,y0)});for(let y=y0;y<y1;y+=30)draw.push({z:z(x0,y+15)-1,f:()=>wallX(y,x0)});
    for(let x=x0;x<x1;x+=30)draw.push({z:z(x+15,y1)+.9,f:()=>{const p1=P(x,y1),p2=P(Math.min(x+30,x1),y1);if(x>x0+20&&x<x1-50)return;poly([[p1[0],p1[1]-PH],[p2[0],p2[1]-PH],p2,p1],gl);rect(ctx,p1[0],p1[1]-PH,p2[0]-p1[0],1,gd)}});for(let y=y0;y<y1;y+=30)draw.push({z:z(x1,y+15)+.9,f:()=>{const p1=P(x1,y),p2=P(x1,Math.min(y+30,y1));poly([[p1[0],p1[1]-PH],[p2[0],p2[1]-PH],p2,p1],gl);rect(ctx,p1[0],p1[1]-PH,1,PH,gd);rect(ctx,p1[0],p1[1]-PH,p2[0]-p1[0],1,gd)}})});
  if(opts.deptSigns==='banner'){world.departments.forEach(dp=>{const cx=(dp.x0+dp.x1)/2,y=dp.y1;
      // floor plate: inset colored strip along the front edge with the name
      poly([P(dp.x0+10,y+2),P(dp.x1-10,y+2),P(dp.x1-10,y+9),P(dp.x0+10,y+9)],'rgba(0,0,0,.35)');poly([P(dp.x0+11,y+3),P(dp.x1-11,y+3),P(dp.x1-11,y+8),P(dp.x0+11,y+8)],shade(dp.color,.35));
      const q=P(cx,y+5);tags.push({x:sx(q[0]),y:sy(q[1]+3),text:dp.name.toUpperCase(),color:dp.color});
      // hanging banner from the ceiling over the pod centre: colored pennant with dark title strip
      draw.push({z:z(cx,dp.y0)+.02,f:()=>{const p=P(cx,dp.y0+6);const top=p[1]-64;rect(ctx,p[0]-1,top,1,10,'#3a3f4a');rect(ctx,p[0]+8,top,1,10,'#3a3f4a');rect(ctx,p[0]-12,top+10,32,2,'#c9a24a');
        rect(ctx,p[0]-12,top+12,32,22,shade(dp.color,.55));rect(ctx,p[0]-11,top+13,30,20,dp.color);rect(ctx,p[0]-11,top+13,30,1,shade(dp.color,1.4));
        ctx.fillStyle=shade(dp.color,.55);ctx.beginPath();ctx.moveTo(p[0]-12,top+34);ctx.lineTo(p[0]+20,top+34);ctx.lineTo(p[0]+4,top+42);ctx.closePath();ctx.fill();
        rect(ctx,p[0]-9,top+18,26,9,'#0d1018');rect(ctx,p[0]-8,top+19,24,7,'#12171f');
        const ini=dp.name.slice(0,2).toUpperCase();ctx.font='bold 6px monospace';ctx.fillStyle=dp.color;ctx.fillText(ini,p[0]-4,top+25);
        if(night>.15){ctx.save();ctx.globalAlpha=.15*night;ctx.fillStyle=dp.color;ctx.fillRect(p[0]-16,top+8,40,40);ctx.restore()}}})})}
  else world.departments.forEach(dp=>{const x=dp.x0+4,y=dp.y0+2;draw.push({z:z(x,y)+.01,f:()=>{const q=P(x,y);rect(ctx,q[0]-1,q[1]-34,2,34,'#3a3f4a');rect(ctx,q[0]-16,q[1]-44,32,11,'#0d1018');rect(ctx,q[0]-15,q[1]-43,30,9,'#12171f');rect(ctx,q[0]-14,q[1]-35,28,1,dp.color);tags.push({x:sx(q[0]),y:sy(q[1]-35),text:dp.name.toUpperCase(),color:dp.color})}})});
  world.desks.forEach((dk,i)=>{const a=dk.agent,st=world.status(a),seated=SEATED.includes(a.state);
    draw.push({z:z(dk.x+30,dk.y-4),f:()=>{box(dk.x+10,dk.y-10,44,14,16,'#e2d9c8','#b3a892','#cfc5b2');const dr=P(dk.x+54,dk.y-2);rect(ctx,dr[0]-6,dr[1]-9,5,1,'#3a3f4a');rect(ctx,dr[0]-6,dr[1]-4,5,1,'#3a3f4a');const m=P(dk.x+34,dk.y-8);rect(ctx,m[0]-9,m[1]-30,19,14,'#14171f');rect(ctx,m[0]-8,m[1]-29,17,12,'#0d1018');screenLines(ctx,m[0]-7,m[1]-28,15,10,st,t,i*13);rect(ctx,m[0]-8,m[1]-29,17,1,'#2a2f3a');rect(ctx,m[0]-1,m[1]-16,3,2,'#14171f');rect(ctx,m[0]-4,m[1]-14,9,1,'#14171f');const k=P(dk.x+22,dk.y-2);rect(ctx,k[0]-5,k[1]-17,10,2,'#20242f');for(let q=0;q<4;q++)rect(ctx,k[0]-4+q*2,k[1]-17,1,1,'#3d4452');rect(ctx,k[0]+7,k[1]-17,2,2,'#c8cfda');const g=P(dk.x+48,dk.y-6);rect(ctx,g[0],g[1]-22,4,5,['#e7eaf0','#f5b34a','#7b8cff'][i%3]);if(i%2){const pl=P(dk.x+16,dk.y-6);rect(ctx,pl[0],pl[1]-23,4,5,'#3d2f27');rect(ctx,pl[0]+1,pl[1]-27,3,4,'#3fa35f');rect(ctx,pl[0]-1,pl[1]-26,2,2,'#56c47a')}
      const lp=P(dk.x+18,dk.y-8);rect(ctx,lp[0],lp[1]-36,1,18,'#3a3f4a');rect(ctx,lp[0]-3,lp[1]-38,8,3,'#3a3f4a');rect(ctx,lp[0]-2,lp[1]-35,6,1,'#f5e2b0');
      if(night>.15&&st!=='paused'){ctx.save();ctx.globalAlpha=.16*night;ctx.fillStyle=E.STATUS[st]||'#2ee6cf';ctx.fillRect(m[0]-18,m[1]-34,40,26);ctx.globalAlpha=.22*night;ctx.fillStyle='#ffd88a';ctx.fillRect(lp[0]-5,lp[1]-34,12,16);ctx.restore()}}});
    draw.push({z:z(dk.x+4,dk.y+10),f:()=>{const ch=P(dk.x+4,dk.y+10);spoly([P(dk.x-2,dk.y+4),P(dk.x+12,dk.y+4),P(dk.x+12,dk.y+18),P(dk.x-2,dk.y+18)],.2);rect(ctx,ch[0]-6,ch[1]-8,12,3,'#2a2f3a');rect(ctx,ch[0]-6,ch[1]-8,12,1,'#3d4452');rect(ctx,ch[0]-6,ch[1]-26,2,18,'#1c1f27');rect(ctx,ch[0]-7,ch[1]-29,9,4,'#2a2f3a');rect(ctx,ch[0]-6,ch[1]-29,7,1,'#3d4452');rect(ctx,ch[0]-1,ch[1]-5,2,4,'#1c1f27');rect(ctx,ch[0]-6,ch[1]-1,12,1,'#1c1f27');
      if(seated){const p=P(dk.x+6,dk.y+8);if(a.state==='blocked')agentSprite(ctx,a,'stand',p[0]-6,p[1]-26,false,t);else agentSprite(ctx,a,'sit',p[0]-6,p[1]-24,false,t);bubble(ctx,a,p[0]-2,p[1]-32,t);tags.push({x:sx(p[0]),y:sy(p[1]+12),text:a.name,color:a.color});hits.push({id:a.id,x:sx(p[0]-8),y:sy(p[1]-26),w:16*S,h:28*S});if(a.id===world.focusId)focusMark(ctx,p[0]-2,p[1]-40,t)}}})});
  const ap=world.arcadePos;draw.push({z:z(ap.x+9,ap.y-4),f:()=>{box(ap.x,ap.y-12,18,12,38,'#2a2340','#1a1530','#221c38');const p=P(ap.x+18,ap.y-2);rect(ctx,p[0]-8,p[1]-38,12,4,'#c084fc');rect(ctx,p[0]-7,p[1]-33,10,8,'#0a0c10');const r=rnd(Math.floor(t*5));for(let i=0;i<5;i++)rect(ctx,p[0]-6+Math.floor(r()*8),p[1]-32+Math.floor(r()*6),1,1,['#2ee6cf','#f5b34a','#fff'][i%3]);rect(ctx,p[0]-7,p[1]-23,10,4,'#3a3050');rect(ctx,p[0]-5,p[1]-22,1,1,'#f87171');rect(ctx,p[0]-1,p[1]-22,1,1,'#2ee6cf');if(night>.1){ctx.save();ctx.globalAlpha=.22*night;ctx.fillStyle='#c084fc';ctx.fillRect(p[0]-14,p[1]-44,26,48);ctx.restore()}}});
  const cp=world.coffeePos;draw.push({z:z(cp.x+10,cp.y-4),f:()=>{box(cp.x,cp.y-12,20,12,26,'#3a4150','#20262f','#2a3040');const p=P(cp.x+20,cp.y-2);rect(ctx,p[0]-6,p[1]-24,8,5,'#0b1f24');rect(ctx,p[0]-5,p[1]-23,Math.floor(t*4)%6,1,'#2ee6cf');rect(ctx,p[0]-3,p[1]-11,4,4,'#e7eaf0');rect(ctx,p[0]-2+Math.floor(t*3)%2,p[1]-15,1,3,'#8a929e')}});
  const vp=world.vendingPos;draw.push({z:z(vp.x+8,vp.y-4),f:()=>{box(vp.x,vp.y-12,16,12,34,'#1d2a3a','#101a26','#162230');const p=P(vp.x+16,vp.y-2);for(let r=0;r<5;r++)for(let c=0;c<3;c++)rect(ctx,p[0]-7+c*2,p[1]-32+r*4,1,3,['#f87171','#f5b34a','#4ade80','#7b8cff','#2ee6cf'][(r+c)%5]);rect(ctx,p[0]+1,p[1]-32,2,12,Math.floor(t*2)%2?'#2ee6cf':'#1a5f66')}});
  const sp=world.sofaPos;draw.push({z:z(sp.x+17,sp.y+5),f:()=>{box(sp.x,sp.y,34,12,7,'#4a3652','#2f2436','#3a2b3f');box(sp.x,sp.y-2,34,3,14,'#3a2b3f','#2a1e30','#33263a',false);const p=P(sp.x+10,sp.y+6);rect(ctx,p[0]-3,p[1]-12,6,4,'#f5b34a');const q=P(sp.x+24,sp.y+6);rect(ctx,q[0]-3,q[1]-12,6,4,'#2ee6cf')}});
  draw.push({z:z(sp.x+17,sp.y+30),f:()=>{box(sp.x+4,sp.y+24,26,12,9,'#5a4436','#3d2f27','#4a382e');const p=P(sp.x+17,sp.y+30);rect(ctx,p[0]-3,p[1]-13,5,4,'#e7eaf0');rect(ctx,p[0]+4,p[1]-12,6,2,'#f5b34a')}});
  const sh=L.shelf;draw.push({z:z(sh.x+12,sh.y+6),f:()=>{box(sh.x,sh.y,24,8,42,'#5a4436','#3d2f27','#4a382e');
    // right face runs from (x,y+8) to (x+24,y+8) in world space; place shelves and books along it
    const a=P(sh.x+1,sh.y+8),b=P(sh.x+23,sh.y+8),len=22,dx=(b[0]-a[0])/len,dy=(b[1]-a[1])/len;
    for(let s=0;s<3;s++){const lift=6+s*12;ctx.fillStyle='#3d2f27';ctx.beginPath();ctx.moveTo(a[0],a[1]-lift);ctx.lineTo(b[0],b[1]-lift);ctx.lineTo(b[0],b[1]-lift+1);ctx.lineTo(a[0],a[1]-lift+1);ctx.closePath();ctx.fill();
      const r=rnd(s+7);for(let i=1;i<len-1;i+=3){const h=5+Math.floor(r()*4),bx=a[0]+dx*i,by=a[1]+dy*i-lift;rect(ctx,bx,by-h,2,h,['#7b8cff','#f5b34a','#2ee6cf','#f87171','#c8cfda'][Math.floor(r()*5)])}}}});
  const co=L.cooler;draw.push({z:z(co.x+4,co.y+6),f:()=>{box(co.x,co.y,8,8,28,'#c8cfda','#9aa3b0','#b3bcc8');const p=P(co.x+8,co.y+4);rect(ctx,p[0]-4,p[1]-40,7,12,'#9ecfea');rect(ctx,p[0]-3,p[1]-39,5,10,'#bfe3f5');rect(ctx,p[0]-3,p[1]-39,5,Math.floor(t*2)%3,'#9ecfea');rect(ctx,p[0]-1,p[1]-20,2,2,'#2ee6cf')}});
  L.plants.forEach(([x,y,big])=>draw.push({z:z(x+5,y+5),f:()=>{box(x,y,10,10,8,'#5a4436','#3d2f27','#4a382e');const p=P(x+5,y+5),h=big?16:10,sw=Math.round(Math.sin(t*1.5+x));rect(ctx,p[0]-1,p[1]-8-h,2,h,'#2f7d4a');rect(ctx,p[0]-5+sw,p[1]-13-h,4,7,'#3fa35f');rect(ctx,p[0]+1-sw,p[1]-15-h,4,8,'#3fa35f');rect(ctx,p[0]-2,p[1]-18-h,4,6,'#56c47a')}}));
  world.agents.filter(a=>!SEATED.includes(a.state)).forEach(a=>draw.push({z:z(a.x+8,a.y),f:()=>{const p=P(a.x+8,a.y);spoly([P(a.x+3,a.y-4),P(a.x+13,a.y-4),P(a.x+13,a.y+4),P(a.x+3,a.y+4)],.25);agentSprite(ctx,a,a.state==='arcade'?'back':'stand',p[0]-8,p[1]-24,a.dir<0,t);bubble(ctx,a,p[0]-2,p[1]-31,t);tags.push({x:sx(p[0]),y:sy(p[1]+12),text:a.name,color:a.color});hits.push({id:a.id,x:sx(p[0]-8),y:sy(p[1]-26),w:16*S,h:28*S});if(a.id===world.focusId)focusMark(ctx,p[0]-2,p[1]-40,t)}}));
  if(opts.fun&&world.boss){const b=world.boss,T=world.throne;draw.push({z:-1e3,f:()=>throneS(ctx,P,box,T.x,T.y,t,night)});
    draw.push({z:z(b.x+8,b.y+8)+(b.state==='sit'?.6:0),f:()=>{const p=P(b.x+8,b.y+8);spoly([P(b.x-4,b.y-2),P(b.x+20,b.y-2),P(b.x+20,b.y+16),P(b.x-4,b.y+16)],.3);bossS(ctx,p[0]-16,p[1]-(b.state==='sit'?66:58),b,t,b.dir<0);
      tags.push({x:sx(p[0]),y:sy(p[1]-66),text:'MASTER',color:'#f5d76e'})}});
    world.sparks.forEach(q=>draw.push({z:z(q.x,q.y)+1.2,f:()=>{const p=P(q.x,q.y);rect(ctx,p[0],p[1]-q.h,2,2,q.color)}}));
    world.agents.forEach(a=>{const fr=world.fear[a.id],pk=world.pickers[a.id];if(!fr&&!pk)return;const d=world.desks[a.deskIdx],st=SEATED.includes(a.state),ax=st?d.x+6:a.x+8,ay=st?d.y+8:a.y;draw.push({z:z(ax,ay)+1.1,f:()=>{const p=P(ax,ay);const sh=fr?Math.round(Math.sin(t*40))*1:0;if(fr){rect(ctx,p[0]-8+sh,p[1]-36,3,3,'#9ecfea');rect(ctx,p[0]+5-sh,p[1]-34,3,3,'#9ecfea');rect(ctx,p[0]-1,p[1]-42,2,6,'#fb7185');rect(ctx,p[0]-1,p[1]-35,2,2,'#fb7185');if(Math.floor(t*10)%2){rect(ctx,p[0]-12,p[1]-18,2,2,'#c8cfda');rect(ctx,p[0]+10,p[1]-16,2,2,'#c8cfda')}}if(pk){const k=Math.floor(t*6)%2;rect(ctx,p[0]-2+k,p[1]-40,4,4,'#f5d76e');rect(ctx,p[0]-2+k,p[1]-40,1,1,'#fff3c4')}}})});
    b.coins.forEach(q=>draw.push({z:z(q.x,q.y)+1,f:()=>{const p=P(q.x,q.y);coinS(ctx,p[0],p[1]-q.h,q,p[1])}}))}
  if(opts.fun&&world.cat){const c=world.cat,rb=world.roomba;draw.push({z:z(c.x,c.y),f:()=>{const p=P(c.x,c.y);catS(ctx,p[0],p[1],c,t)}});draw.push({z:z(rb.x,rb.y),f:()=>{const p=P(rb.x,rb.y);roombaS(ctx,p[0],p[1],t)}});
    draw.push({z:z(lg.x0+34,lg.y1-8),f:()=>{const p=P(lg.x0+34,lg.y1-8);aquariumS(ctx,p[0]-12,p[1],t,night)}});draw.push({z:z(lg.x0+70,lg.y1-30),f:()=>{const p=P(lg.x0+70,lg.y1-30);beanS(ctx,p[0],p[1],'#4a7a5a')}});draw.push({z:z(lg.x0+90,lg.y1-22),f:()=>{const p=P(lg.x0+90,lg.y1-22);beanS(ctx,p[0],p[1],'#c0653a')}});
    const pd=world.desks[world.partyDesk];if(pd)draw.push({z:z(pd.x+56,pd.y-2)+.5,f:()=>{const p=P(pd.x+56,pd.y-2);balloonsS(ctx,p[0]-4,p[1]-14,t)}});
    world.confetti.forEach(q=>draw.push({z:z(q.x,q.y)+1,f:()=>{const p=P(q.x,q.y);confettiS(ctx,p[0],p[1]-q.h,q)}}))}
  draw.sort((p,q)=>p.z-q.z).forEach(o=>o.f());
  ctx.setTransform(1,0,0,1,0,0);if(TD){ctx.fillStyle=TD.ambient;ctx.fillRect(0,0,CW,CH)}else{ctx.fillStyle='rgba(14,22,58,'+(.42*night).toFixed(3)+')';ctx.fillRect(0,0,CW,CH);if(d>0&&d<.6){ctx.fillStyle='rgba(255,140,80,'+(.08*(1-Math.abs(d-.3)/.3)).toFixed(3)+')';ctx.fillRect(0,0,CW,CH)}}
  labelsPx(ctx,tags.filter(x=>(S>=2||x.text===x.text.toUpperCase())&&x.x>-40&&x.x<CW+40&&x.y>0&&x.y<CH+20));world[(opts.viewKey||'view6')+'Hits']=hits;
}
E.WorldD=WorldD;E.renderIsoE=renderIsoE;

/* v6 side view: 8 pods rendered as two floor rows (front row band 0, back row band 1), lounge wing at the right, wheel zoom */
function renderSideE(ctx,world,opts){opts=opts||{};
  const cv=ctx.canvas,CW=cv.width,CH=cv.height,W=world.W,WALL=100,H=250,t=world.t,TD=opts.tod?E.tod(world.hour):null,d=TD?TD.light:world.daylight(),night=1-d,L=world.layout,winF=TD?windowE:windowC;
  const v=world.sview6||(world.sview6={S:1,ox:0,oy:0,w:W,h:H,levels:[1,2,3,4]});fit(v,CW,CH);const S=v.S,sx=x=>v.ox+x*S,sy=y=>v.oy+y*S;
  ctx.setTransform(1,0,0,1,0,0);ctx.fillStyle='#07080b';ctx.fillRect(0,0,CW,CH);ctx.setTransform(S,0,0,S,v.ox,v.oy);const tags=[],hits=[];
  wallD(ctx,W,WALL,d);floorD(ctx,W,WALL+2,H,d,5);
  for(let x=60;x<W;x+=88)pendant(ctx,x,10,night);
  L.windows.forEach((wx,i)=>winF(ctx,wx,14,58,52,world,11+i*12));
  rect(ctx,100,18,14,14,'#e8e2d6');rect(ctx,101,19,12,12,'#0d1018');rect(ctx,102,20,10,10,'#f4f1ea');{const cx=107,cy=25,ha=(world.hour%12)/12*Math.PI*2-Math.PI/2,ma=(world.hour%1)*Math.PI*2-Math.PI/2;ctx.strokeStyle='#1a1c24';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(cx,cy);ctx.lineTo(cx+Math.cos(ha)*3,cy+Math.sin(ha)*3);ctx.stroke();ctx.beginPath();ctx.moveTo(cx,cy);ctx.lineTo(cx+Math.cos(ma)*4.5,cy+Math.sin(ma)*4.5);ctx.stroke()}
  [[200,18],[228,18],[256,18],[372,18],[400,18],[512,18],[540,18]].forEach(([x,y],i)=>{shadow(ctx,x+1,y+1,22,30,.2);rect(ctx,x,y,22,30,'#e8e2d6');rect(ctx,x+1,y+1,20,28,['#1d2a3a','#2a1e30','#1e2a24','#2a2418','#1a2230','#2a1e30','#1e2a24'][i]);rect(ctx,x+4,y+6,14,3,['#2ee6cf','#c084fc','#4ade80','#f5b34a','#7b8cff','#fb7185','#4ade80'][i]);rect(ctx,x+4,y+12,10,2,'#c8cfda');rect(ctx,x+4,y+16,14,2,'#c8cfda');rect(ctx,x+4,y+20,7,2,'#c8cfda')});
  shadow(ctx,11,13,74,56,.2);drawBoard(ctx,world,10,12,74,56);tags.push({x:sx(47),y:sy(12)-2,text:'TASK BOARD',color:'#2ee6cf'});
  // back-row (band 1) department signs on wall
  world.departments.forEach(dp=>{if(dp.band!==1)return;const w=dp.x1-dp.x0;rect(ctx,dp.x0+6,78,w-12,10,'#14171f');rect(ctx,dp.x0+7,79,w-14,8,'#1c2230');rect(ctx,dp.x0+8,86,w-16,1,dp.color);tags.push({x:sx((dp.x0+dp.x1)/2),y:sy(87)-1,text:dp.name.toUpperCase(),color:dp.color})});
  const lg=L.lounge;rect(ctx,lg.x0+20,78,70,10,'#14171f');rect(ctx,lg.x0+21,79,68,8,'#1c2230');rect(ctx,lg.x0+22,86,66,1,'#f5b34a');tags.push({x:sx(lg.x0+55),y:sy(87)-1,text:'LOUNGE',color:'#f5b34a'});
  if(opts.fun){neonS(ctx,lg.x0+14,36,t,night);lightsS(ctx,lg.x0-26,W-4,72,t,night);neonS(ctx,214,52,t,night)}
  if(d>.05){ctx.save();ctx.globalAlpha=.12*d;ctx.fillStyle=TD?TD.horizon:'#ffe9b0';L.windows.forEach(x=>{ctx.beginPath();ctx.moveTo(x,66);ctx.lineTo(x+58,66);ctx.lineTo(x+84,H);ctx.lineTo(x-14,H);ctx.closePath();ctx.fill()});ctx.restore()}
  const LF=158;shadow(ctx,lg.x0-2,LF-6,110,30,.12);rect(ctx,lg.x0-2,LF-4,110,26,'#4a3a48');rect(ctx,lg.x0,LF-2,106,22,'#3a2b3f');for(let i=0;i<5;i++)rect(ctx,lg.x0+4+i*21,LF+2,12,14,'#4a3652');
  shelfC(ctx,lg.x0-24,LF-2);arcadeC(ctx,lg.x0+8,LF-2,t,night);coffeeC(ctx,lg.x0+34,LF-2,t);vendingC(ctx,lg.x0+60,LF-2,t);sofaC(ctx,lg.x0+40,LF+42);coolerC(ctx,lg.x0+94,LF-6,t);plantC(ctx,lg.x0-40,LF,t,true);plantC(ctx,20,LF+4,t,false);plantC(ctx,W-16,H-10,t,true);
  // world y → screen floor y: band1 (y≈196..252) → back row, band0 (y≈44..100) → front row, corridor between
  const BFY=[128,150],FFY=[214,240],corrY=y=>{if(y<=100)return FFY[0]+(y-44)/56*(FFY[1]-FFY[0]);if(y>=196)return BFY[0]+(y-196)/56*(BFY[1]-BFY[0]);return BFY[1]+8+(y-100)/96*(FFY[0]-BFY[1]-16)};
  const items=[];
  world.desks.forEach((dk,i)=>{const fy=Math.round(corrY(dk.y)),a=dk.agent,seated=SEATED.includes(a.state),x=dk.x;items.push({z:fy,f:()=>{deskD(ctx,x,fy,a,world,t,i+1,night);
    if(seated){if(a.state==='blocked'){agentSprite(ctx,a,'stand',x+1,fy-24,false,t);bubble(ctx,a,x+6,fy-32,t)}else{agentSprite(ctx,a,'sit',x+2,fy-24,false,t);bubble(ctx,a,x+6,fy-31,t)}
      tags.push({x:sx(x+9),y:sy(fy)+13,text:a.name,color:a.color});hits.push({id:a.id,x:sx(x-3),y:sy(fy-30),w:20*S,h:32*S});if(a.id===world.focusId)focusMark(ctx,x+8,fy-42,t)}}})});
  world.agents.filter(a=>!SEATED.includes(a.state)).forEach(a=>{const fy=Math.round(corrY(a.y));items.push({z:fy+.5,f:()=>{shadow(ctx,a.x+2,fy-1,12,2,.3);agentSprite(ctx,a,a.state==='arcade'?'back':'stand',a.x,fy-24,a.dir<0,t);bubble(ctx,a,a.x+6,fy-31,t);
    tags.push({x:sx(a.x+8),y:sy(fy)+13,text:a.name,color:a.color});hits.push({id:a.id,x:sx(a.x),y:sy(fy-26),w:16*S,h:28*S});if(a.id===world.focusId)focusMark(ctx,a.x+6,fy-38,t)}})});
  if(opts.fun&&world.cat){const c=world.cat,rb=world.roomba,cy=Math.round(corrY(c.y)),ry=Math.round(corrY(rb.y));items.push({z:cy+.2,f:()=>catS(ctx,c.x,cy,c,t)});items.push({z:ry+.2,f:()=>roombaS(ctx,rb.x,ry,t)});
    items.push({z:LF+24,f:()=>{aquariumS(ctx,lg.x0+2,LF+24,t,night);beanS(ctx,lg.x0+50,LF+30,'#4a7a5a');beanS(ctx,lg.x0+70,LF+26,'#c0653a')}});
    const pd=world.desks[world.partyDesk];if(pd){const py=Math.round(corrY(pd.y));items.push({z:py+.3,f:()=>balloonsS(ctx,pd.x+52,py-18,t)})}
    world.confetti.forEach(q=>items.push({z:1e4,f:()=>confettiS(ctx,q.x,corrY(q.y)-q.h,q)}))}
  items.sort((p,q)=>p.z-q.z).forEach(o=>o.f());
  world.departments.forEach(dp=>{if(dp.band!==0)return;rect(ctx,dp.x0-2,FFY[1]+4,dp.x1-dp.x0+4,1,dp.color);tags.push({x:sx((dp.x0+dp.x1)/2),y:sy(FFY[1]+16),text:dp.name.toUpperCase(),color:dp.color})});
  ctx.setTransform(1,0,0,1,0,0);if(TD){ctx.fillStyle=TD.ambient;ctx.fillRect(0,0,CW,CH)}else{ctx.fillStyle='rgba(14,22,58,'+(.42*night).toFixed(3)+')';ctx.fillRect(0,0,CW,CH);if(d>0&&d<.6){ctx.fillStyle='rgba(255,140,80,'+(.08*(1-Math.abs(d-.3)/.3)).toFixed(3)+')';ctx.fillRect(0,0,CW,CH)}}
  labelsPx(ctx,tags.filter(x=>(S>=2||x.text===x.text.toUpperCase())&&x.x>-40&&x.x<CW+40&&x.y>0&&x.y<CH+20));world.sview6Hits=hits;
}
E.renderSideE=renderSideE;

/* v7: time-of-day palette + fun props (cat, roomba, aquarium, neon, balloons, confetti, bean bags, string lights, birds/clouds) */
const TOD=[[0,'#070b18','#141a33',[14,22,58],.45,0,'Night'],[5,'#0e1530','#3a2a4a',[30,20,60],.38,.05,'Dawn'],[6.5,'#6a4a7a','#f08a5a',[255,120,70],.16,.4,'Dawn'],[8,'#8fbde8','#ffd9a8',[255,200,140],.06,.9,'Morning'],[12,'#6fb0ea','#cfe6f7',[255,255,255],0,1,'Noon'],[16,'#7fb2e0','#f7d9a0',[255,190,90],.07,.9,'Afternoon'],[18,'#c86a5a','#ffb060',[255,140,60],.18,.5,'Dusk'],[19.5,'#3a2a5a','#b0507a',[90,40,100],.28,.15,'Evening'],[21,'#0a1024','#1a2040',[14,22,58],.42,0,'Night'],[24,'#070b18','#141a33',[14,22,58],.45,0,'Night']];
E.tod=function(h){h=((h%24)+24)%24;let i=0;while(i<TOD.length-2&&TOD[i+1][0]<=h)i++;const a=TOD[i],b=TOD[i+1],k=(h-a[0])/(b[0]-a[0]),mix=(p,q)=>p+(q-p)*k;const rgb=a[3].map((v,j)=>Math.round(mix(v,b[3][j])));return{sky:lerpC(a[1],b[1],k),horizon:lerpC(a[2],b[2],k),ambient:'rgba('+rgb.join(',')+','+mix(a[4],b[4]).toFixed(3)+')',light:mix(a[5],b[5]),label:a[6]}};
function windowE(ctx,x,y,w,h,world,seed){const T=E.tod(world.hour),t=world.t,d=T.light,hr=world.hour;rect(ctx,x-2,y-2,w+4,h+4,'#e8e2d6');rect(ctx,x-1,y-1,w+2,h+2,'#2a2f3a');
  for(let i=0;i<h;i+=2)rect(ctx,x,y+i,w,2,lerpC(T.sky,T.horizon,Math.pow(i/h,1.6)));
  if(d<.5){ctx.save();ctx.globalAlpha=1-d*2;stars(ctx,x,y,w,h/2,seed,t);ctx.restore()}
  ctx.save();ctx.beginPath();ctx.rect(x,y,w,h);ctx.clip();
  const sT=(hr-6)/12;if(sT>-.06&&sT<1.06){const sx=Math.round(x+2+sT*(w-8)),sy=Math.round(y+h-6-Math.sin(Math.max(0,Math.min(1,sT))*Math.PI)*(h-12)),sc=lerpC('#ff9a4a','#fff3c4',Math.min(1,d*1.5));rect(ctx,sx,sy,5,5,sc);rect(ctx,sx+1,sy-1,3,1,sc);rect(ctx,sx+1,sy+5,3,1,sc);rect(ctx,sx-1,sy+1,1,3,sc);rect(ctx,sx+5,sy+1,1,3,sc)}
  if(hr>=18||hr<6){const mT=hr>=18?(hr-18)/12:(hr+6)/12,mx=Math.round(x+2+mT*(w-8)),my=Math.round(y+h-6-Math.sin(mT*Math.PI)*(h-12));rect(ctx,mx,my,6,6,'#f5efd0');rect(ctx,mx+1,my-1,4,1,'#f5efd0');rect(ctx,mx+1,my+6,4,1,'#f5efd0');rect(ctx,mx+3,my+1,3,3,lerpC(T.sky,'#f5efd0',.2))}
  if(d>.15){ctx.save();ctx.globalAlpha=.8*Math.min(1,d*1.5);const r=rnd(seed+7),cc=lerpC(T.horizon,'#ffffff',.55);for(let i=0;i<3;i++){const cw=10+Math.floor(r()*10),cy=y+4+Math.floor(r()*(h*.4)),spd=2+r()*3,cx=Math.round(x+((r()*w+t*spd)%(w+cw))-cw);rect(ctx,cx,cy+2,cw,3,cc);rect(ctx,cx+2,cy,cw-5,2,cc)}ctx.restore()}
  if(d>.4){const r=rnd(seed+3);for(let i=0;i<2;i++){const spd=10+r()*8,by=y+6+Math.floor(r()*(h*.35)),bx=Math.round(x+((r()*w+t*spd)%(w+8))-4),fl=Math.floor(t*6+i)%2;rect(ctx,bx,by+fl,1,1,'#1a1c24');rect(ctx,bx+1,by,1,1,'#1a1c24');rect(ctx,bx+2,by+fl,1,1,'#1a1c24')}}
  ctx.restore();
  const r=rnd(seed);let bx=x+2;const bcol=lerpC('#111626','#5a6a86',d);while(bx<x+w-6){const bw=4+Math.floor(r()*7),bh=8+Math.floor(r()*(h*.45));rect(ctx,bx,y+h-bh,bw,bh,bcol);for(let i=0;i<4;i++){const lit=r()>(.3+d*.6);if(lit)rect(ctx,bx+1+Math.floor(r()*(bw-2)),y+h-bh+2+Math.floor(r()*(bh-3)),1,1,'#f5c76a')}bx+=bw+1}
  rect(ctx,x+w/2-1,y,2,h,'#2a2f3a');rect(ctx,x,y+h/2-1,w,2,'#2a2f3a')}
function catS(ctx,x,y,c,t){const col='#e8a04a',dk='#b8742e';ctx.save();ctx.translate(Math.round(x),Math.round(y));if(c.dir<0)ctx.scale(-1,1);
  if(c.state==='sleep'){rect(ctx,-5,-4,10,4,col);rect(ctx,-6,-3,2,2,col);rect(ctx,4,-6,3,3,col);rect(ctx,4,-7,1,1,col);rect(ctx,6,-7,1,1,col);if(Math.floor(t*1.5)%2)rect(ctx,8,-10,1,1,'#c8cfda');ctx.restore();return}
  const bob=c.state==='walk'?Math.floor(t*8)%2:0,tw=Math.round(Math.sin(t*4));rect(ctx,-4,-5-bob,8,4,col);rect(ctx,3,-8-bob,4,4,col);rect(ctx,3,-9-bob,1,1,col);rect(ctx,6,-9-bob,1,1,col);rect(ctx,6,-7-bob,1,1,'#1a1c24');rect(ctx,-6,-8-bob+tw,2,3,dk);rect(ctx,-5,-6-bob,1,1,dk);
  if(c.state==='walk'){rect(ctx,-3,-1-bob,1,1+bob,dk);rect(ctx,2,-2+bob,1,2-bob,dk)}else{rect(ctx,-3,-1,1,1,dk);rect(ctx,2,-1,1,1,dk);rect(ctx,-4,-2,8,1,col)}ctx.restore()}
function roombaS(ctx,x,y,t){x=Math.round(x);y=Math.round(y);shadow(ctx,x-5,y-1,10,2,.3);rect(ctx,x-5,y-3,10,3,'#2a2f3a');rect(ctx,x-4,y-4,8,1,'#3d4452');rect(ctx,x-3,y-3,6,1,'#4a505c');rect(ctx,x+2,y-4,1,1,Math.floor(t*3)%2?'#4ade80':'#1f5f3a')}
function aquariumS(ctx,x,y,t,night){x=Math.round(x);y=Math.round(y);rect(ctx,x,y-6,24,6,'#2a2f3a');rect(ctx,x+1,y-6,22,1,'#3d4452');rect(ctx,x+1,y-22,22,16,'#0f2a36');for(let i=0;i<14;i+=2)rect(ctx,x+2,y-21+i,20,2,lerpC('#1b5f78','#0b3a4c',i/14));rect(ctx,x+2,y-21,20,1,'#7fd3ea');
  [['#f5b34a',0],['#2ee6cf',1],['#fb7185',2]].forEach(([c,i])=>{const fx=x+4+Math.round((Math.sin(t*.9+i*2.1)*.5+.5)*13),fy=y-18+i*4+Math.round(Math.sin(t*2+i)),dir=Math.cos(t*.9+i*2.1)>0;rect(ctx,fx,fy,3,2,c);rect(ctx,dir?fx-1:fx+3,fy,1,2,c);rect(ctx,dir?fx+2:fx,fy,1,1,'#1a1c24')});
  for(let i=0;i<3;i++){const by=y-8-((t*6+i*5)%13);rect(ctx,x+18-i*2,Math.round(by),1,1,'rgba(255,255,255,.6)')}rect(ctx,x+3,y-8,18,2,'#c9a86a');rect(ctx,x+6,y-11,2,3,'#3fa35f');rect(ctx,x+15,y-12,2,4,'#3fa35f');
  if(night>.1){ctx.save();ctx.globalAlpha=.18*night;ctx.fillStyle='#2ee6cf';ctx.fillRect(x-4,y-26,32,28);ctx.restore()}}
function neonS(ctx,x,y,t,night){const on=Math.floor(t*1.3)%9!==4||Math.sin(t*40)>0;ctx.save();rect(ctx,x-3,y-9,52,13,'#0d1018');ctx.font='8px Silkscreen, monospace';ctx.textAlign='left';ctx.textBaseline='alphabetic';if(on&&night>.05){ctx.shadowColor='#ff4fa3';ctx.shadowBlur=8*night}ctx.fillStyle=on?'#ff5fb0':'#5a1d3a';ctx.fillText('SHIP IT',x,y);ctx.fillStyle=on?'#ffb3dc':'#5a1d3a';ctx.fillRect(x,y+2,46,1);ctx.restore()}
function balloonsS(ctx,x,y,t){[['#fb7185',0],['#f5b34a',5],['#7b8cff',10]].forEach(([c,dx],i)=>{const b=Math.round(Math.sin(t*1.4+i)*1.5);rect(ctx,x+dx,y-24+b,1,10,'rgba(200,207,218,.5)');rect(ctx,x+dx-2,y-31+b,5,7,c);rect(ctx,x+dx-1,y-32+b,3,1,c);rect(ctx,x+dx-1,y-24+b,3,1,c);rect(ctx,x+dx-1,y-30+b,1,2,'rgba(255,255,255,.6)')})}
function beanS(ctx,x,y,c){x=Math.round(x);y=Math.round(y);shadow(ctx,x-7,y-1,15,2,.25);rect(ctx,x-7,y-7,14,7,c);rect(ctx,x-6,y-8,12,1,c);rect(ctx,x-6,y-8,8,1,shade(c,1.25));rect(ctx,x-5,y-6,3,1,shade(c,1.25))}
function lightsS(ctx,x0,x1,y,t,night){rect(ctx,x0,y,x1-x0,1,'#3a3f4a');for(let x=x0+4,i=0;x<x1;x+=7,i++){const c=['#fb7185','#f5b34a','#4ade80','#7b8cff','#2ee6cf'][i%5],on=night<.1||Math.floor(t*2+i)%5!==0;rect(ctx,x,y+1,1,2,'#3a3f4a');rect(ctx,x-1,y+3,3,3,on?c:shade(c,.4));if(on&&night>.1){ctx.save();ctx.globalAlpha=.35*night;ctx.fillStyle=c;ctx.fillRect(x-3,y+1,7,7);ctx.restore()}}}
function confettiS(ctx,px,py,p){rect(ctx,Math.round(px),Math.round(py),2,p.life>.4?2:1,p.color)}
function throneS(ctx,P,box,x,y,t,night){ // throne against the left wall (x≈0), facing +x; stairs descend toward +x
  const fl=Math.floor(t*8)%3;
  // stepped dais: three tiers rising toward the wall
  box(x-22,y-30,40,66,3,'#4a2a30','#2a161c','#3a2026');box(x-22,y-24,30,54,6,'#5e1620','#3a0e16','#4a1018');box(x-22,y-18,20,42,9,'#7a1f2a','#4a1018','#5e1620');
  // stair nosing gold lines
  // red carpet down the stairs into corridor
  ctx.fillStyle='#8a1a24';const c1=P(x+18,y-6),c2=P(x+60,y-6),c3=P(x+60,y+10),c4=P(x+18,y+10);ctx.beginPath();ctx.moveTo(c1[0],c1[1]);ctx.lineTo(c2[0],c2[1]);ctx.lineTo(c3[0],c3[1]);ctx.lineTo(c4[0],c4[1]);ctx.closePath();ctx.fill();
  const e1=P(x+18,y-6),e2=P(x+60,y-6),e3=P(x+18,y+10),e4=P(x+60,y+10);ctx.strokeStyle='#c9a24a';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(e1[0],e1[1]+.5);ctx.lineTo(e2[0],e2[1]+.5);ctx.moveTo(e3[0],e3[1]+.5);ctx.lineTo(e4[0],e4[1]+.5);ctx.stroke();
  // wall backdrop: tall crimson drape with gold sunburst, hung on the left wall behind throne
  const w0=P(x-22,y-26),w1=P(x-22,y+30);const wx=w0[0],wy0=w0[1],wy1=w1[1];
  
  const dr=(dy0,dy1,col)=>{ctx.fillStyle=col;ctx.beginPath();ctx.moveTo(w0[0],w0[1]+dy0);ctx.lineTo(w1[0],w1[1]+dy0);ctx.lineTo(w1[0],w1[1]+dy1);ctx.lineTo(w0[0],w0[1]+dy1);ctx.closePath();ctx.fill()};
  dr(-60,-8,'#5e1620');dr(-60,-57,'#c9a24a');dr(-12,-8,'#c9a24a');for(let i=0;i<7;i++){const q=P(x-22,y-22+i*8);rect(ctx,q[0],q[1]-57,1,46,i%2?'#4a1018':'#7a1f2a')}
  // sunburst medallion on drape
  const m=P(x-22,y+2);for(let i=0;i<12;i++){const a=i/12*Math.PI*2;rect(ctx,m[0]+Math.round(Math.cos(a)*9),m[1]-42+Math.round(Math.sin(a)*9),2,2,'#f5d76e')}rect(ctx,m[0]-4,m[1]-46,8,8,'#c9a24a');rect(ctx,m[0]-2,m[1]-44,4,4,'#f5d76e');rect(ctx,m[0]-1,m[1]-43,2,2,'#e0323c');
  // the throne itself: tall high-back, winged, gold crest
  const b=P(x-10,y+6);const tb=b[1];
  rect(ctx,b[0]-14,tb-52,28,44,'#4a1018');rect(ctx,b[0]-12,tb-50,24,40,'#7a1f2a');rect(ctx,b[0]-10,tb-48,20,34,'#a3272f');rect(ctx,b[0]-8,tb-46,16,28,'#c23a44');
  for(let i=0;i<3;i++)rect(ctx,b[0]-8,tb-42+i*9,16,1,'#8a1a24');rect(ctx,b[0]-1,tb-46,2,28,'#8a1a24');
  rect(ctx,b[0]-16,tb-56,4,50,'#c9a24a');rect(ctx,b[0]+12,tb-56,4,50,'#c9a24a');rect(ctx,b[0]-18,tb-34,3,24,'#c9a24a');rect(ctx,b[0]+15,tb-34,3,24,'#c9a24a');
  rect(ctx,b[0]-16,tb-59,32,3,'#c9a24a');rect(ctx,b[0]-5,tb-65,10,6,'#f5d76e');rect(ctx,b[0]-2,tb-69,4,4,'#f5d76e');rect(ctx,b[0]-11,tb-63,4,4,'#f5d76e');rect(ctx,b[0]+7,tb-63,4,4,'#f5d76e');rect(ctx,b[0]-1,tb-63,2,2,'#e0323c');rect(ctx,b[0]-10,tb-62,2,2,'#2ee6cf');rect(ctx,b[0]+8,tb-62,2,2,'#2ee6cf');
  // seat cushion + armrests
  rect(ctx,b[0]-12,tb-24,24,8,'#8a1a24');rect(ctx,b[0]-12,tb-24,24,1,'#c23a44');rect(ctx,b[0]-16,tb-30,5,10,'#c9a24a');rect(ctx,b[0]+11,tb-30,5,10,'#c9a24a');rect(ctx,b[0]-15,tb-32,3,3,'#f5d76e');rect(ctx,b[0]+12,tb-32,3,3,'#f5d76e');
  // wall sconces: iron brackets with fire bowls, flanking the drape on the left wall
  [P(x-22,y-40),P(x-22,y+44)].forEach(p=>{const bx=p[0],by=p[1]-30;
    rect(ctx,bx-1,by,2,10,'#3a3f4a');rect(ctx,bx-1,by+9,5,2,'#3a3f4a');rect(ctx,bx-4,by-4,10,5,'#2a2f3a');rect(ctx,bx-3,by-5,8,1,'#c9a24a');rect(ctx,bx-4,by-2,10,1,'#4a5060');
    const r=rnd(Math.floor(t*10)+bx);for(let i=0;i<6;i++){const fx=bx-3+Math.floor(r()*7),fh=3+Math.floor(r()*8);rect(ctx,fx,by-5-fh,2,fh,i<2?'#e0323c':i<4?'#f5b34a':'#fff3c4')}
    rect(ctx,bx-2,by-9-fl,6,4,'#f5b34a');rect(ctx,bx-1,by-12-fl,4,3,'#fff3c4');rect(ctx,bx,by-14-fl*2,2,2,'rgba(255,255,255,.5)');
    ctx.save();ctx.globalAlpha=.2+.28*night;ctx.fillStyle='#ffb347';ctx.beginPath();ctx.arc(bx,by-6,16+fl,0,Math.PI*2);ctx.fill();ctx.restore()});
  if(night>.2){ctx.save();ctx.globalAlpha=.14*night;ctx.fillStyle='#f5d76e';ctx.fillRect(b[0]-24,tb-72,48,70);ctx.restore()}}
function bossS(ctx,x,y,b,t,flip){ // 2x scaled big boss, ~16x28 base -> 32x56
  const S2=2,R=(cx,cy,w,h,c)=>rect(ctx,x+(flip?32-cx-w:cx)*1,y+cy,w,h,c);
  const sit=b.state==='sit',walk=b.state==='walk'||b.state==='home',f=Math.floor(t*5)%2;
  const bob=walk?(f?1:0):0,y0=bob;
  // cape
  if(!sit){R(2,20+y0,28,26,'#6b0f1a');R(4,44+y0,24,4,'#4a0a12')}
  // legs
  if(sit){R(8,40,8,10,'#1a1520');R(18,40,8,10,'#1a1520');R(6,48,10,4,'#0d0a10');R(18,48,10,4,'#0d0a10')}
  else{R(9,40+y0,6,12,'#1a1520');R(17,40+(walk&&f?-2:0)+y0,6,12,'#1a1520');R(8,52+y0,8,4,'#0d0a10');R(16,52+y0,8,4,'#0d0a10')}
  // torso (suit + gold trim)
  R(6,20+y0,20,20,'#2a1d33');R(8,22+y0,16,16,'#3b2848');R(14,22+y0,4,16,'#f5d76e');R(6,20+y0,20,2,'#c9a24a');
  // arms
  const arm=(ax,ay,c)=>{R(ax,ay,5,12,c);R(ax,ay+12,5,4,'#f1c9a5')};
  if(b.state==='coins'){arm(0,12+y0,'#3b2848');R(-2,8+y0,6,5,'#f1c9a5');arm(27,22,'#3b2848')}
  else if(b.state==='whip'){const up=Math.sin(b.whip*9)>0;arm(27,up?8:22,'#3b2848');arm(0,22,'#3b2848');
    // whip lash
    const wx=x+(flip?-2:34),dir=flip?-1:1;for(let i=0;i<14;i++){const wy=y+(up?10:26)+Math.round(Math.sin(b.whip*14+i*.7)*4*(i/14))+i*(up?1.4:.2);rect(ctx,wx+dir*i*3,wy,3,2,i<10?'#6b4a2e':'#c9a24a')}}
  else{arm(1,22+y0,'#3b2848');arm(26,22+y0,'#3b2848')}
  // head
  R(8,6+y0,16,14,'#f1c9a5');R(8,4+y0,16,4,'#3a2418');R(10,12+y0,3,2,'#1a1c24');R(19,12+y0,3,2,'#1a1c24');R(11,17+y0,10,1,'#8a3b2a');
  // beard + crown
  R(9,16+y0,14,5,'#3a2418');R(12,20+y0,8,3,'#3a2418');
  R(7,0+y0,18,5,'#f5d76e');R(7,-3+y0,3,4,'#f5d76e');R(14,-4+y0,4,5,'#f5d76e');R(22,-3+y0,3,4,'#f5d76e');R(10,1+y0,2,2,'#e0323c');R(20,1+y0,2,2,'#2ee6cf');R(15,2+y0,2,2,'#7b8cff');
  // cigar
  R(flip?4:24,15+y0,5,2,'#5a3a26');R(flip?3:29,15+y0,1,2,'#f5b34a');if(f)R(flip?2:30,12+y0,2,2,'rgba(200,200,200,.5)')}
function coinS(ctx,px,py,q,gy){px=Math.round(px);py=Math.round(py);
  if(gy!=null){ctx.save();ctx.globalAlpha=Math.max(.1,.35-q.h*.006);ctx.fillStyle='#000';ctx.fillRect(px-2,Math.round(gy)-1,5,2);ctx.restore()}
  const c=Math.cos(q.ph),w=Math.max(1,Math.round(Math.abs(c)*5)),lit=c>0;
  if(q.settled){ // lying flat: small ellipse
    rect(ctx,px-2,py-1,5,2,'#c9a24a');rect(ctx,px-1,py-1,3,1,'#f5d76e');rect(ctx,px-2,py,5,1,'#8a6a1e');rect(ctx,px+2,py-1,1,1,'#fff3c4');return}
  const x0=px-Math.floor(w/2);
  if(w<=1){rect(ctx,x0,py-3,1,6,'#e0b64a');rect(ctx,x0,py-2,1,1,'#fff3c4');return}
  rect(ctx,x0,py-3,w,6,'#c9a24a');rect(ctx,x0,py-2,w,4,lit?'#f5d76e':'#d4a93a');rect(ctx,x0+(lit?0:w-1),py-3,1,6,'#8a6a1e');rect(ctx,x0,py-3,w,1,'#fff3c4');
  if(w>=4){rect(ctx,x0+1,py-1,w-2,1,'#b8902e');rect(ctx,x0+1,py,w-2,1,'#b8902e')}
  if(lit&&Math.floor(q.ph*3)%4===0)rect(ctx,x0+w-1,py-3,1,1,'#ffffff')}
class WorldE extends WorldD{
  constructor(cfg){super(cfg);this.hourLock=null;this.cat={x:300,y:CORR+6,dir:1,state:'walk',timer:5};this.roomba={i:0,x:40,y:CORR-6,path:[{x:40,y:CORR-6},{x:590,y:CORR-6},{x:590,y:290},{x:40,y:290},{x:40,y:CORR-6},{x:40,y:16},{x:590,y:16},{x:590,y:CORR-6}]};this.confetti=[];this.lastSeq=0;this.partyDesk=5;
    this.throne={x:6,y:CORR-6};this.boss={x:6-16,y:CORR-6,dir:1,state:'sit',timer:6,coins:[],whip:0,tx:0,ty:0};this.fear={};this.pickers={};this.sparks=[]}
  bossTick(dt){const b=this.boss,T=this.throne;b.timer-=dt;
    const pick=()=>{const r=Math.random();if(r<.35){b.state='walk';b.tx=90+Math.random()*Math.max(60,this.W-240);b.ty=CORR-6+Math.random()*10;b.timer=30}else if(r<.55){b.state='coins';b.timer=2.6;for(let i=0;i<30;i++)b.coins.push({x:b.x+(b.dir<0?-6:22),y:b.y+(Math.random()-.5)*6,h:34,vx:b.dir*(15+Math.random()*75),vy:(Math.random()-.5)*36,vh:20+Math.random()*70,life:8+Math.random()*4,ph:Math.random()*6.28,sp:8+Math.random()*10,bounces:0,settled:false})}else if(r<.75){b.state='whip';b.timer=2.2;b.whip=0}else if(r<.9){b.state='home';b.tx=T.x-16;b.ty=T.y;b.timer=30}else{b.state='stand';b.timer=2+Math.random()*2}};
    if(b.state==='sit'){if(b.timer<=0){b.state='stand';b.timer=1.2}}
    else if(b.state==='stand'){if(b.timer<=0)pick()}
    else if(b.state==='walk'||b.state==='home'){const dx=b.tx-b.x,dy=b.ty-b.y,dd=Math.hypot(dx,dy),sp=34*dt;if(dd<=sp||b.timer<=0){b.x=b.tx;b.y=b.ty;if(b.state==='home'){b.state='sit';b.dir=1;b.timer=8+Math.random()*10}else{b.state='stand';b.timer=.8+Math.random()*1.5}}else{b.x+=dx/dd*sp;b.y+=dy/dd*sp;b.dir=dx<0?-1:1}}
    else if(b.state==='coins'){if(b.timer<=0){b.state='stand';b.timer=1}}
    else if(b.state==='whip'){b.whip+=dt;if(b.whip<dt*1.5){this.agents.forEach(a=>{const d=this.desks[a.deskIdx];const ax=SEATED.includes(a.state)?d.x+6:a.x,ay=SEATED.includes(a.state)?d.y+8:a.y;if(Math.hypot(ax-b.x,ay-b.y)<130){this.fear[a.id]=6+Math.random()*3;for(let i=0;i<4;i++)this.sparks.push({x:ax+8,y:ay,h:26+i*3,life:.5,color:'#ffffff'})}})}if(b.timer<=0){b.state='stand';b.timer=1.5}}
    Object.keys(this.fear).forEach(k=>{this.fear[k]-=dt;if(this.fear[k]<=0)delete this.fear[k]});
    Object.keys(this.pickers).forEach(k=>{this.pickers[k]-=dt;if(this.pickers[k]<=0)delete this.pickers[k]});
    this.sparks.forEach(q=>{q.life-=dt;q.h+=30*dt});this.sparks=this.sparks.filter(q=>q.life>0);
    b.coins.forEach(q=>{if(q.settled&&!q.taken){this.agents.forEach(a=>{if(q.taken)return;const d=this.desks[a.deskIdx];const ax=SEATED.includes(a.state)?d.x+6:a.x,ay=SEATED.includes(a.state)?d.y+8:a.y;if(Math.hypot(ax-q.x,ay-q.y)<26){q.taken=true;q.life=Math.min(q.life,.15);this.pickers[a.id]=1.6;a.coins=(a.coins||0)+1;this.sparks.push({x:q.x,y:q.y,h:4,life:.5,color:'#f5d76e'})}})}});
    b.coins.forEach(q=>{q.life-=dt;if(q.settled){q.ph+=dt*.5;return}q.x+=q.vx*dt;q.y+=q.vy*dt;q.h+=q.vh*dt;q.vh-=140*dt;q.ph+=q.sp*dt;if(q.h<=0){q.h=0;q.bounces++;q.vh=-q.vh*(.45-q.bounces*.08);q.vx*=.6;q.vy*=.6;q.sp*=.6;if(q.vh<6||q.bounces>3){q.vh=0;q.settled=true;q.vx=0;q.vy=0;q.ph=Math.PI/2+(Math.random()-.5)*.3}}});b.coins=b.coins.filter(q=>q.life>0)}
  tick(dt){super.tick(dt);this.agents.forEach(a=>{if(this.fear&&this.fear[a.id]&&a.task&&a.state==='work'&&a.progress<100)a.progress=Math.min(100,a.progress+dt*12)});if(this.hourLock!=null)this.hour=this.hourLock;this.bossTick(dt);
    const c=this.cat;c.timer-=dt;if(c.state==='walk'){c.x+=c.dir*13*dt;if(c.x<44){c.x=44;c.dir=1}const cmx=this.W-134;if(c.x>cmx){c.x=cmx;c.dir=-1}if(c.timer<=0){c.state=Math.random()<.5?'sit':'sleep';c.timer=4+Math.random()*6}}else if(c.timer<=0){c.state='walk';c.dir=Math.random()<.5?-1:1;c.timer=5+Math.random()*9}
    const r=this.roomba,p=r.path[r.i],dx=p.x-r.x,dy=p.y-r.y,dd=Math.hypot(dx,dy),sp=20*dt;if(dd<=sp){r.x=p.x;r.y=p.y;r.i=(r.i+1)%r.path.length}else{r.x+=dx/dd*sp;r.y+=dy/dd*sp}
    if(this.events.length&&this.events[0].seq>this.lastSeq){const ne=this.events.filter(e=>e.seq>this.lastSeq);this.lastSeq=this.events[0].seq;ne.forEach(e=>{if(!/done|merged/.test(e.type))return;const a=this.agents.find(x=>x.name===e.agent);if(!a)return;const d=this.desks[a.deskIdx];for(let i=0;i<28;i++)this.confetti.push({x:d.x+30,y:d.y-4,h:22,vx:(Math.random()-.5)*50,vy:(Math.random()-.5)*20,vh:40+Math.random()*55,life:1.8+Math.random()*.8,color:['#2ee6cf','#f5b34a','#c084fc','#4ade80','#fb7185','#ffffff'][i%6]})})}
    this.confetti.forEach(q=>{q.life-=dt;q.x+=q.vx*dt;q.y+=q.vy*dt;q.h+=q.vh*dt;q.vh-=110*dt;q.vx*=.985;if(q.h<0){q.h=0;q.vh=0;q.vx=0;q.vy=0}});this.confetti=this.confetti.filter(q=>q.life>0)}
  daylight(){return E.tod(this.hour).light}
}
E.WorldE=WorldE;
/* v8: fully dynamic layout — any number of departments × agents; pods sized to fit, lounge follows */
class WorldF extends WorldE{
  constructor(cfg){super(cfg);const n=this.departments.length,per=Math.max(1,...this.departments.map(d=>this.agents.filter(a=>a.dept===d.index).length));
    const cols=Math.ceil(per/2),podW=cols*60,pitch=podW+20,nCols=Math.max(1,Math.ceil(n/2));
    this.PX=Array.from({length:nCols},(_,i)=>70+i*pitch);const podsEnd=70+(nCols-1)*pitch+podW-30;const lx0=Math.max(podsEnd+40,300);this.W=lx0+110;this.D=310;
    this.arcadePos={x:lx0+16,y:44};this.coffeePos={x:lx0+42,y:44};this.vendingPos={x:lx0+68,y:44};this.sofaPos={x:lx0+30,y:96};
    const windows=[];for(let x=132;x<lx0-70;x+=140)windows.push(x);if(!windows.length)windows.push(Math.max(110,lx0-90));
    this.layout={corridor:[136,160],lounge:{x0:lx0,y0:30,x1:this.W,y1:130},windows,shelf:{x:this.W-24,y:80},cooler:{x:lx0+2,y:38},plants:[[20,290,true],[this.W-20,290,true],[20,20,false],[lx0-10,290,false],[Math.round(lx0/2),136,false]]};
    this.desks=[];this.departments.forEach((d,i)=>{const px=this.PX[i%nCols],bi=Math.floor(i/nCols),band=BANDS[bi];d.band=bi;d.x0=px-6;d.x1=px+podW;d.y0=band[0]-16;d.y1=band[1]+14;
      this.agents.filter(a=>a.dept===i).forEach((a,j)=>{const x=px+(j%cols)*60,y=band[Math.floor(j/cols)];a.deskIdx=this.desks.length;this.desks.push({x,y,dept:i,agent:a});a.x=x+2;a.y=y})});
    const rx=this.W-130;this.roomba.path=[{x:40,y:CORR-6},{x:rx,y:CORR-6},{x:rx,y:290},{x:40,y:290},{x:40,y:CORR-6},{x:40,y:16},{x:rx,y:16},{x:rx,y:CORR-6}];this.cat.x=Math.min(this.cat.x,rx);this.partyDesk=Math.min(5,this.desks.length-1)}
}
E.WorldF=WorldF;
const DEPT_POOL=[['Product','#7b8cff','pm'],['Engineering','#2ee6cf','developer'],['QA','#c084fc','qa'],['DevOps','#f5b34a','sre'],['Data','#4ade80','analyst'],['Security','#fb7185','security'],['Research','#38bdf8','researcher'],['Support','#fbbf24','support'],['Design','#f472b6','designer'],['Platform','#a3e635','developer'],['Growth','#fb923c','marketer'],['Finance','#94a3b8','analyst']];
const NAME_POOL=['Dijkstra','Lovelace','Knuth','Perlis','Ada','Linus','Hopper','Torvalds','Grace','Turing','Church','Kleene','Ritchie','Thompson','Kernighan','Pike','Bayes','Fisher','Gauss','Laplace','Diffie','Hellman','Rivest','Shamir','Shannon','Minsky','McCarthy','Hinton','Berners','Cerf','Kahn','Postel','Euler','Noether','Hamilton','Backus','Liskov','Hoare','Wirth','Kay','Engelbart','Sutherland','Lamport','Codd','Stroustrup','Gosling','Matsumoto','Rossum','Wall','Eich','Carmack','Sweeney','Babbage','Boole','Cantor','Godel','Hilbert','Riemann','Ramanujan','Erdos','Tao','Wiles','Conway','Nash','Neumann','Wiener','Zuse','Atanasoff','Eckert','Mauchly','Forrester','Kilby','Noyce','Moore','Grove','Hennessy','Patterson','Cocke','Amdahl','Cray','Dennard','Faggin','Hoff','Mazor','Shima'];
E.makeDepartments=function(deptCount,perDept){deptCount=Math.max(1,Math.min(12,deptCount|0));perDept=Math.max(1,Math.min(8,perDept|0));let k=0;return Array.from({length:deptCount},(_,i)=>{const [name,color,role]=DEPT_POOL[i%DEPT_POOL.length];return{name,color,agents:Array.from({length:perDept},()=>({name:NAME_POOL[(k++)%NAME_POOL.length],role}))}})};
})();
