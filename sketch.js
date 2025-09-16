// Ghost Squad · p5.js  —— 修复包一体化：背景贴图、两行顶栏、节流发射、尾迹自上而下渐隐、鬼图等比缩放、图层顺序
const W=480, H=800, INIT_KARMA=30, ROUND=60;
const SHIP_Y=H-120, SPELL_V=6;   // 符纸速度减慢
const SHIP_SCALE=1.5;            // 飞船等比放大 1.5 倍
const SHIP_BOTTOM_MARGIN=10;     // 游戏界面：飞船底距屏幕 10px 固定
const LABEL_FONT=18, NUM_FONT=20; // 顶栏字号：标签/数字
const NUM_BOX_W=68, NUM_BOX_H=26; // 数值黄框固定大小
const FIRE_MS=800;            // 发射间隔（慢一点）
const MAX_SPELLS=8;           // 屏幕内最大符纸数量
const SPAWN_MIN=600, SPAWN_MAX=1200;
// 小鬼间距控制（生成与运行时的拥挤缓解）
const GHOST_MIN_SPAWN_DIST_X = 72;   // 生成时与附近小鬼的最小水平间距
const GHOST_NEAR_SPAWN_Y     = 160;  // 仅检查顶部这段区域以减少挤在入口
const GHOST_SEP_NEAR_Y       = 120;  // 分离时，仅对垂直距离较近的鬼生效
const GHOST_SEP_PUSH         = 0.6;  // 每帧水平推开的像素（小、柔和）
const GHOST_SEP_EVERY_N_FRAMES = 2;  // 每 N 帧做一次分离，降低 O(n^2) 频率
const ESCAPE_PENALTY=1, TOUCH_PENALTY=3;

let state="INTRO", timeLeft=ROUND, karma=INIT_KARMA;
let timeMs = ROUND * 1000;   // 倒计时毫秒制
let lastTickMs = 0;          // 上一帧的毫秒时间戳
let dtMs = 16.67;            // 最近一帧原始耗时（ms）
let moveScale = 1.0;         // 运动缩放：相对 60fps 的倍数（dtMs / 16.667）
let moveDtCappedMs = 16.67;  // 限幅后的 dt（用于轨迹写入等）
let lastHitName="", lastHitAt=0;
let imgShipIdle,imgShipHit,imgShipRed,imgShipFrozen,imgSpell;
let bgm,shootS,hitS,warnS,buzzS; // hitS 允许是 p5.SoundFile 或数组
let audioUnlocked=false;         // 是否已通过用户手势解锁音频
// 静态图层缓存，减少每帧重复绘制开销（旧设备更流畅）
let bgLayer=null;   // 背景（渐变 + 网格贴图/网格线）
let topbarLayer=null; // 顶栏贴图平铺
let ghostImgs=[];   // 全局缓存小鬼动图（避免每次 spawn 都 loadImage）
let preloadPlan={ started:false, total:0, loaded:0, errors:0, done:false };
let bgTex=null, topbarTex=null;            // 背景&顶栏贴图
let ghosts=[], spells=[];
let floatMsgs=[]; // 顶栏数值浮动动画队列
let ship={x:W/2,y:SHIP_Y,state:"idle",until:0,w:80,h:80};
let lastFire=0,lastSpawn=0,nextSpawn=800;
// 数字着色：记录最近一次变动的方向与时间（用于短暂高亮）
let lastKarmaDelta=0, lastKarmaChangeAt=0;
let lastTimeDelta=0,  lastTimeChangeAt=0;
const HILIGHT_MS=1000;
let cnv=null;                 // p5 画布引用，用于做等比缩放显示
let stats={hit:0, names:[]}, endReason="";
let uiPage=null;      // 结算界面子页：null | 'dex' | 'shop'
let clickPos=null;    // 一次性点击位置（按钮触发）
let dexCache={};      // 图鉴页面图片缓存 idx->p5.Image
let dexScroll=0, dexScrollMax=0; // 图鉴滚动
let lastTouchY=null;  // 图鉴触控滚动

// 顶部 UI 区域与黑条常量（用于碰撞判定阈值）
const BLACK_STRIP_Y = 90;
const BLACK_STRIP_H = 35;
const HIT_ACTIVE_Y = BLACK_STRIP_Y + BLACK_STRIP_H + 20; // g.y 超过此值才判定击中

function preload(){
  if(window.ASSETS){
    const S=ASSETS.ship_images||{};
    if(S.idle)   imgShipIdle=loadImage(S.idle);
    if(S.hit)    imgShipHit=loadImage(S.hit);
    if(S.red)    imgShipRed=loadImage(S.red);
    if(S.frozen) imgShipFrozen=loadImage(S.frozen);
    if(ASSETS.spell_image) imgSpell=loadImage(ASSETS.spell_image);

    // 贴图：
    if(ASSETS.bg_images && ASSETS.bg_images.length)  bgTex    = loadImage(ASSETS.bg_images[0]);
    if(ASSETS.ui_images && ASSETS.ui_images.length)  topbarTex= loadImage(ASSETS.ui_images[0]);

    // 小鬼动图改为进入开始页后异步预载，以便更快显示开始页

    const A=ASSETS.audio||{};
    if(A.bgm)   bgm   = loadSound(A.bgm,()=>{},()=>{});
    if(A.shoot) shootS= loadSound(A.shoot,()=>{},()=>{});
    if(A.hit){
      if(Array.isArray(A.hit)){
        hitS = A.hit.map(p => loadSound(p,()=>{},()=>{}));
      } else {
        hitS = loadSound(A.hit,()=>{},()=>{});
      }
    }
    if(A.warn)  warnS = loadSound(A.warn,()=>{},()=>{});
    if(A.buzz)  buzzS = loadSound(A.buzz,()=>{},()=>{});
  }
}

// 根据容器尺寸把 480x800 画布按竖屏比例等比缩放到可视区域
// 仅改变 CSS 尺寸，不改变 p5 的逻辑坐标（width/height 仍为 W/H）
window.updateCanvasScale = function updateCanvasScale(){
  try{
    const holder = document.getElementById('canvas-holder');
    if(!holder) return;
    const container = document.getElementById('container') || document.body;
    const vw = container.clientWidth;
    const vh = container.clientHeight;
    const targetW = W, targetH = H;
    const scale = Math.min(vw/targetW, vh/targetH);
    const cssW = Math.max(1, Math.round(targetW * scale));
    const cssH = Math.max(1, Math.round(targetH * scale));

    const canvasEl = cnv?.elt || holder.querySelector('canvas');
    if(canvasEl){
      canvasEl.style.width  = cssW + 'px';
      canvasEl.style.height = cssH + 'px';
    }
    // 同步 holder 与 UI 覆盖层尺寸，保证对齐
    holder.style.width  = cssW + 'px';
    holder.style.height = cssH + 'px';
    const overlay = document.getElementById('ui-overlay');
    if(overlay){
      overlay.style.width  = cssW + 'px';
      overlay.style.height = cssH + 'px';
    }
  }catch(e){ /* 忽略尺寸计算中的偶发错误 */ }
}

function setup(){
  // 保持清晰度：不强制降像素密度
  cnv = createCanvas(W,H); cnv.parent("canvas-holder");
  frameRate(60); // 60fps，保证 GIF 动画与交互更顺畅
  nextSpawn=random(SPAWN_MIN,SPAWN_MAX);
  // 初次进入时做一次缩放适配
  if(window.updateCanvasScale) window.updateCanvasScale();
  // 注册一次性音频解锁（移动端/桌面统一处理）
  registerAudioUnlock();
  // 桌面端尽早尝试启动 BGM（若浏览器允许的话），初始音量按当前状态
  try{ tryUnlockAudioAndPlayBgm(); }catch(e){}
  // 构建静态图层（背景与顶栏平铺），避免每帧重绘大量图形
  buildStaticLayers();
  // 启动小鬼与图鉴动图的后台预载
  startPreloadGhosts();
}

// p5 的窗口变化回调：同步触发缩放
function windowResized(){ if(window.updateCanvasScale) window.updateCanvasScale(); }

function draw(){
  // 每帧同步 BGM 音量到目标值（PLAY=50%，END-dex/shop=50%，其余=100%）
  syncBgmVolume();
  // 开始页：黑底介绍 + 出发按钮
  if(state==="INTRO"){ introScreen(); return; }

  drawBackground();                 // 先画背景色 + 网格
  // 先更新飞船固定 Y（避免发射/碰撞使用旧的 Y）
  updateShipFixedY();

  // 基于真实时间的倒计时，避免掉帧导致“变慢”
  if(state==="PLAY"){
    const now = millis();
    if(lastTickMs===0) lastTickMs = now;
    const dtRaw = now - lastTickMs; lastTickMs = now;
    dtMs = dtRaw;
    // 限幅运动用 dt，避免后台切回导致瞬移过大（不影响倒计时）
    moveDtCappedMs = Math.min(dtRaw, 50);
    moveScale = moveDtCappedMs / (1000/60);
    // 基于真实时间的倒计时
    const beforeSec = Math.ceil(timeMs/1000);
    timeMs = Math.max(0, timeMs - dtRaw);
    const afterSec = Math.ceil(timeMs/1000);
    if(afterSec !== beforeSec){ setTime(afterSec, afterSec - beforeSec); }
    if(timeMs<=0){ endReason="TIME"; endGame(); }
  } else {
    // 非 PLAY 时保持运动缩放为 1
    moveScale = 1.0; moveDtCappedMs = 1000/60;
  }

  if(state==="PLAY"){
    if(millis()-lastSpawn>nextSpawn){ spawnGhost(); lastSpawn=millis(); nextSpawn=random(SPAWN_MIN,SPAWN_MAX); }
    if(millis()-lastFire>FIRE_MS){ fireSpell(); lastFire=millis(); }
  }

  // 先更新，再按层次绘制：小鬼 → 符纸（置顶于小鬼） → 顶栏 → 飞船
  if(state==="PLAY"){
    updateSpells();                 // 仅更新，不绘制（END 时不再更新分数/碰撞）
    updateGhosts();                 // 更新并绘制小鬼
    drawSpells();                   // 最后画符纸，覆盖在小鬼之上
  }
  drawTopBars();                    // topbars（顶栏）
  drawShip();                       // ship（飞船，置于最上层）

  if(state==="END") endScreen();
}

// 统一音频解锁与 BGM 启动逻辑
function registerAudioUnlock(){
  const handler = ()=>{
    tryUnlockAudioAndPlayBgm();
  };
  const events = ['pointerdown','touchstart','touchend','mousedown','click','keydown'];
  events.forEach(ev=>{
    try{ window.addEventListener(ev, handler, {passive:true}); }catch(e){}
    try{ document.addEventListener(ev, handler, {passive:true}); }catch(e){}
    try{ if(cnv && cnv.elt) cnv.elt.addEventListener(ev, handler, {passive:true}); }catch(e){}
  });
}

function tryUnlockAudioAndPlayBgm(){
  try{
    if(typeof userStartAudio === 'function') userStartAudio();
    const ac = getAudioContext ? getAudioContext() : null;
    if(ac && ac.state !== 'running' && ac.resume) ac.resume();
  }catch(e){}
  audioUnlocked = true;
  // 启动/维持 BGM（避免重复叠加）
  if(bgm){
    const target = getBgmTargetVolume();
    try{
      const isPlaying = (typeof bgm.isPlaying === 'function') ? bgm.isPlaying() : false;
      if(!isPlaying){
        bgm.setLoop(true);
        bgm.setVolume(target);
        bgm.play();
      } else {
        // 已在播，仅调整音量
        if(bgm.setVolume) bgm.setVolume(target, 0.2);
      }
    }catch(e){
      // 安全兜底（仍避免多次调用造成重叠）
      try{ if(!bgm.isPlaying || (typeof bgm.isPlaying==='function' && !bgm.isPlaying())) { bgm.setLoop(true); bgm.setVolume(target); bgm.play(); } }catch(_){}
    }
  }
}

function getBgmTargetVolume(){
  // INTRO 与结算主页为 100%；游戏页为 50%；结算子页（图鉴/商店）为 50%
  if(state === 'PLAY') return 0.5;
  if(state === 'END' && (uiPage==='dex' || uiPage==='shop')) return 0.5;
  return 1.0;
}

function syncBgmVolume(){
  const target = getBgmTargetVolume();
  try{
    if(bgm && typeof bgm.isPlaying==='function' && bgm.isPlaying()){
      bgm.setVolume(target, 0.2);
    }
  }catch(e){ try{ bgm.setVolume(target); }catch(_){} }
}

/* ============ 开始页：黑底介绍 + 出发按钮 ============ */
function introScreen(){
  push();
  // 黑底
  noStroke(); fill(0); rect(0,0,width,height);

  // 标题
  fill(255); textAlign(CENTER,TOP); textStyle(BOLD);
  textSize(22);
  text('✨ 欢迎加入解忧中元护灵行动 ✨', width/2, 28);
  textStyle(NORMAL);

  // 飞船动图（idle）
  let yTop = 28 + 32; // 标题下方留白
  if(imgShipIdle && imgShipIdle.width>0){
    const sw=imgShipIdle.width, sh=imgShipIdle.height;
    const maxW = width * 0.4;
    const maxH = 180;
    const s = Math.min(maxW/sw, maxH/sh);
    const dw = sw*s, dh = sh*s;
    image(imgShipIdle, (width-dw)/2, yTop, dw, dh);
    yTop += dh + 10;
  } else {
    // 占位
    noStroke(); fill(40,40,60); rect(width/2-60, yTop, 120, 120, 8); yTop += 130;
  }

  // 说明文字
  const pad = 18;
  const tw = width - pad*2;
  fill(235); textAlign(CENTER,TOP); textSize(15); textLeading(22);
  const lines = [
    '你将驾驶吐豆豆号飞船🛸\n在60秒内释放符纸，并收集游荡的小鬼头\n目标：收集小鬼、积累功德！',
    '小鬼头们的属性各不相同\n不同颜色标记点代表不同的效果\n功德加减、冻结飞船、神秘加分、时间回溯…\n——\n它们究竟是助人为乐的友灵\n还是调皮混沌的捣蛋鬼👻？',
    '💜游戏中的每个小鬼头都由历年\n阿忒梦工厂·解忧中元工作坊的参与者设计',
    '操作：拖动飞船左右移动，符纸自动发射\n注意：撞到小鬼、让小鬼溜走只会扣一丢丢功德哦'
  ];
  let y = yTop + 2;
  for(let i=0;i<lines.length;i++){
    const block = lines[i];
    text(block, pad, y, tw, height - y - 100);
    const lineCount = block.split('\n').length;
    const blockH = lineCount * 22; // 依据 textLeading 估算段落高度
    y += blockH + 16; // 段落间距 16
  }

  // 出发按钮 + 预载进度（加载完才可进入）
  const bw=220, bh=50;
  const bx = (width-bw)/2, by = height - 100;
  const percent = (preloadPlan.total>0) ? Math.round((preloadPlan.loaded/preloadPlan.total)*100) : (preloadPlan.started?0:0);
  const ready = preloadPlan.done;
  const label = ready ? '出发！' : `出发！（加载中 ${percent}%）`;
  button(bx, by, bw, bh, label, ready ? ()=>{ tryUnlockAudioAndPlayBgm(); restart(); } : null);
  // 额外提示
  fill(200); textAlign(CENTER,TOP); textSize(12);
  const tip = ready ? 'GO！' : '正在加载…';
  text(tip, width/2, by + bh + 8);

  pop();
}

/* ============ 一次性构建静态图层：背景/顶栏贴图平铺 ============ */
function buildStaticLayers(){
  // 背景层（渐变 + 网格）
  try{
    bgLayer = createGraphics(W, H);
    const pg = bgLayer;
    // 顶部 90% 纯黑 + 底部 10% 黑→紫渐变
    const ctx = pg.drawingContext;
    pg.noStroke();
    pg.fill(0); pg.rect(0, 0, W, H);
    const startY = H * 0.9;
    const grad = ctx.createLinearGradient(0, startY, 0, H);
    grad.addColorStop(0, 'rgba(0,0,0,1)');
    grad.addColorStop(1, 'rgba(200,150,230,1)');
    ctx.fillStyle = grad; ctx.fillRect(0, startY, W, H - startY);

    // 网格层叠加：使用贴图时平铺，否则画线
    if(bgTex && bgTex.width>0){
      const dw = bgTex.width/1.2;
      const dh = bgTex.height/1.2;
      for(let y=0;y<H;y+=dh){
        for(let x=0;x<W;x+=dw){
          pg.image(bgTex,x,y,dw,dh);
        }
      }
    } else {
      pg.push(); pg.noFill(); pg.stroke(0,255,80,15);
      for(let x=0;x<W;x+=24) pg.line(x,0,x,H);
      for(let y=0;y<H;y+=24) pg.line(0,y,W,y);
      pg.pop();
    }
  }catch(e){ bgLayer=null; }

  // 顶栏平铺
  try{
    topbarLayer = createGraphics(W, 90);
    const ph = topbarLayer;
    ph.clear();
    if(topbarTex && topbarTex.width>0){
      const s = 100 / topbarTex.height;
      const dw = topbarTex.width * s;
      for(let x=0; x<W; x+=dw){ ph.image(topbarTex, x, 0, dw, 90); }
    }
  }catch(e){ topbarLayer=null; }
}

/* ============ 后台预载小鬼动图与图鉴缓存 ============ */
function startPreloadGhosts(){
  if(preloadPlan.started) return;
  const list = (window.ASSETS && ASSETS.ghost_images) ? ASSETS.ghost_images : [];
  preloadPlan.started = true;
  preloadPlan.total = list.length;
  preloadPlan.loaded = 0;
  preloadPlan.errors = 0;
  preloadPlan.done = (list.length===0);
  ghostImgs = new Array(list.length);
  for(let i=0;i<list.length;i++){
    const url = list[i];
    // 用 p5 的异步 loadImage，不阻塞 UI；加载完成后写入 ghostImgs 与 dexCache
    loadImage(url,
      (img)=>{ ghostImgs[i]=img; dexCache[i]=img; preloadPlan.loaded++; if(preloadPlan.loaded+preloadPlan.errors>=preloadPlan.total) preloadPlan.done=true; },
      ()=>{ preloadPlan.errors++; if(preloadPlan.loaded+preloadPlan.errors>=preloadPlan.total) preloadPlan.done=true; }
    );
  }
}

/* ============ 背景：先画背景色，再叠加网格贴图/网格线 ============ */
function drawBackground(){
  if(!bgLayer) buildStaticLayers();
  if(bgLayer){ image(bgLayer, 0, 0, width, height); return; }
  // 兜底（极少数情况下构建失败）：用纯黑背景
  push(); noStroke(); fill(0); rect(0,0,width,height); pop();
}

/* ============ 两行显示：上行标题/命中名；下行功德/时间 ============ */
function drawTopBars(){
  // 上行
  push(); noStroke(); fill(0,0,0,140); rect(0,0,width,40);
  if(!topbarLayer) buildStaticLayers();
  if(topbarLayer){ image(topbarLayer, 0, 0, width, 90); }
  textAlign(CENTER,CENTER); textSize(18);
  const show=(millis()-lastHitAt)<1200;
  const titleTxt = show?`${lastHitName}`:`解忧中元·吐豆豆号`;
  // 标题框，位于贴图栏（0~100）中心
  push();
  const TITLE_BOX_W=240, TITLE_BOX_H=32;
  const cx=width/2, cy=45; // 贴图栏中心
  rectMode(CENTER);
  stroke(80,60,10); strokeWeight(4); fill(200,230,70);
  rect(cx, cy, TITLE_BOX_W, TITLE_BOX_H, 6);
  pop();
  // 文字（居中）
  fill(30,50,40);
  text(titleTxt, width/2, 45);
  pop();

  // 黑条（先画，后面的文字与黄框覆盖在其上层）
  const stripH=35, margin=0; 
  push(); noStroke(); fill(0,0,0,200);
  rect(margin, 90, width - margin*2, stripH, 2);
  pop();

  // 功德时间数值框（只在数值下层）
  const cy2=90+stripH/2;
  const leftLabelX=12;
  textSize(LABEL_FONT); fill(80,255,140); textAlign(LEFT,CENTER); // 绿色文字
  const kLabel='功德：'; text(kLabel, leftLabelX, cy2);
  const kLabelW=textWidth(kLabel);
  const kBoxX = leftLabelX + kLabelW + 6;
  push(); noStroke(); fill(200,230,70); rect(kBoxX, cy2-NUM_BOX_H/2, NUM_BOX_W, NUM_BOX_H, 4); pop();

  // 右侧时间：固定大小框在右侧，标签左对齐其左边
  const rightMargin=12;
  const TIME_SHIFT=24; // 时间框整体左移
  const tBoxX = width - rightMargin - NUM_BOX_W - TIME_SHIFT;
  const tLabel='时间：';
  textAlign(RIGHT,CENTER); text(tLabel, tBoxX-6, cy2);
  push(); noStroke(); fill(200,230,70); rect(tBoxX, cy2-NUM_BOX_H/2, NUM_BOX_W, NUM_BOX_H, 4); pop();

  // 数字（框里，水平居中）：加分绿，减分红；未高亮时保持原红色
  textSize(NUM_FONT); textAlign(CENTER,CENTER);
  const karmaStr = String(karma);
  const timeStr  = `${timeLeft}s`;
  const now = millis();
  // 颜色选择
  let kR=220,kG=40,kB=40; // 默认红
  let tR=220,tG=40,tB=40; // 默认红
  if(now - lastKarmaChangeAt < HILIGHT_MS){
    if(lastKarmaDelta>0){ kR=30; kG=160; kB=50; } // 绿
    else if(lastKarmaDelta<0){ kR=220; kG=40; kB=40; } // 红
  }
  if(now - lastTimeChangeAt < HILIGHT_MS){
    if(lastTimeDelta>0){ tR=80; tG=255; tB=140; }
    else if(lastTimeDelta<0){ tR=220; tG=40; tB=40; }
  }
  fill(kR,kG,kB); text(karmaStr, kBoxX + NUM_BOX_W/2, cy2);
  fill(tR,tG,tB); text(timeStr,  tBoxX + NUM_BOX_W/2, cy2);

  // 浮动数字动画（与数字对齐，居中叠放）
  // 浮现动画锚点：移动到两个框的右侧
  const kFloatX = kBoxX + NUM_BOX_W + 16;
  const tFloatX = tBoxX + NUM_BOX_W + 16;
  renderFloatMsgs({karma:{x:kFloatX,y:cy2}, time:{x:tFloatX,y:cy2}});
  pop();
}

/* ============ 生成位置：尽量与顶部区域其他小鬼保持水平间距 ============ */
function pickSpawnX(){
  const left=40, right=width-40; // 与边界保持安全边
  const attempts = 16;
  let bestX = random(left, right);
  let bestMinDX = -1;
  for(let k=0;k<attempts;k++){
    const x = random(left, right);
    // 计算与顶部可见小鬼的最小水平距离
    let minDX = Infinity;
    for(const g of ghosts){
      if(!g || !g.alive || g.stuck) continue;
      if(g.y > GHOST_NEAR_SPAWN_Y) continue; // 只考虑顶端区域
      const dx = abs(x - g.x);
      if(dx < minDX) minDX = dx;
    }
    if(minDX === Infinity) return x;              // 顶部无鬼，直接使用
    if(minDX > GHOST_MIN_SPAWN_DIST_X) return x;  // 满足最小间距
    if(minDX > bestMinDX){ bestMinDX = minDX; bestX = x; }
  }
  // 多次尝试仍不满足，则选择“最不拥挤”的 bestX
  return bestX;
}

/* ============ 生成小鬼 ============ */
function spawnGhost(){
  const defs=window.GHOST_DEFS, imgs=ASSETS.ghost_images||[];
  // 加权随机：
  const weights = defs.map(d=>{
    if(d.name==='小津同学') return 0.15;
    if(d.name==='无限番茄鬼') return 0.5;
    if(d.name==='财神爷') return 0.5;
    if(d.name==='大鬼吃小鬼') return 0.7;
    if(d.name==='没人懂我的忧郁') return 0.7;
    return 1.0;
  });
  let sumW=0; for(const w of weights) sumW+=w;
  let r=random(sumW);
  let idx=0; for(let i=0;i<defs.length;i++){ r-=weights[i]; if(r<=0){ idx=i; break; } }
  let def=defs[idx];
  // 使用预加载的全局缓存，避免运行时重复创建 <img>
  let img=null; if(ghostImgs && ghostImgs.length){ img = ghostImgs[idx] || ghostImgs[int(random(ghostImgs.length))]; }
  ghosts.push({
    x:pickSpawnX(), y:-60, img, def,
    vy:random(1.5,3.2), swayT:random(0.01,0.03), phase:random(TWO_PI),
    alive:true, fading:false, alpha:255, say:0, r:28,
    hitLocked:false, stuck:false, freezeUntil:0, fadeStartAt:0, fadeDuration:700
  });
}

/* ============ 轻量分离：近身时左右小幅推开，减少重叠 ============ */
function separateGhosts(){
  const n = ghosts.length;
  for(let i=0;i<n;i++){
    const a = ghosts[i];
    if(!a || !a.alive || a.stuck) continue;
    for(let j=i+1;j<n;j++){
      const b = ghosts[j];
      if(!b || !b.alive || b.stuck) continue;
      const dy = abs(a.y - b.y);
      if(dy > GHOST_SEP_NEAR_Y) continue; // 仅在垂直相近时考虑分离
      const dx = a.x - b.x;
      const rr = (a.r||28) + (b.r||28);
      const distSq = dx*dx + dy*dy;
      if(distSq <= (rr*rr*0.9)){ // 轻度重叠或逼近
        let dir = 0;
        if(dx > 0) dir = 1; else if(dx < 0) dir = -1; else dir = random([-1,1]);
        const push = GHOST_SEP_PUSH;
        a.x = constrain(a.x + dir*push, 40, width-40);
        b.x = constrain(b.x - dir*push, 40, width-40);
      }
    }
  }
}

/* ============ 发射符纸（节流 + 数量上限） ============ */
function fireSpell(){
  if(spells.length>=MAX_SPELLS) return;
  spells.push({x:ship.x, y:ship.y-40, trail:[], alive:true});
  if(shootS) shootS.play();
}

/* ============ 更新符纸（尾迹从弹头→尾端渐隐） ============ */
function updateSpells(){
  for(let i=spells.length-1;i>=0;i--){
    let s=spells[i]; if(!s.alive){spells.splice(i,1);continue;}
    // 被命中后“钉住”时：不再移动/生长尾迹
    if(s.stuck){
      if(s.link && s.link.alive){ /* 固定在命中处，随小鬼生命周期 */ }
      else { s.alive=false; spells.splice(i,1); continue; }
    } else {
      // 尾迹减少更新开销：按时间间隔记录轨迹点（约每 33ms 一点）
      s._trailMs = (s._trailMs||0) + moveDtCappedMs;
      if(s._trailMs >= 33){ s._trailMs = 0; s.trail.push({x:s.x,y:s.y}); if(s.trail.length>8) s.trail.shift(); }
      s.y -= SPELL_V * moveScale; if(s.y<-20) s.alive=false;
    }
  }
}

function drawSpells(){
  for(let i=0;i<spells.length;i++){
    const s=spells[i]; if(!s.alive) continue;
    // 尾迹：仅未命中时绘制
    if(!s.stuck){
      // 用矢量圆点代替贴图 + tint，减少 draw 调用与状态切换
      push(); noStroke();
      for(let t=0;t<s.trail.length;t++){
        const p=s.trail[t];
        const alpha=map(t,0,s.trail.length-1,30,110);
        const r=map(t,0,s.trail.length-1,10,4);
        fill(255,240,100, alpha);
        circle(p.x,p.y,r);
      }
      pop();
    }
    // 本体：若粘连，随小鬼 alpha 同步渐隐
    let alpha = 255;
    if(s.stuck && s.link){ alpha = s.link.alpha ?? 255; }
    push(); tint(255,alpha);
    if(imgSpell){ image(imgSpell,s.x-14,s.y-14,28,28); }
    else { noStroke(); fill(255,255,180,alpha); circle(s.x,s.y,16); }
    pop(); noTint();
  }
}

/* ============ 更新小鬼（等比缩放，不拉伸；UI最后画） ============ */
function updateGhosts(){
  // 先做一轮轻量分离（隔帧进行，减少老设备负载）
  if(frameCount % GHOST_SEP_EVERY_N_FRAMES === 0){ separateGhosts(); }
  for(let i=ghosts.length-1;i>=0;i--){
    let g=ghosts[i]; if(!g.alive){ghosts.splice(i,1);continue;}
    if(!g.stuck){
      g.x += sin(g.phase) * 0.8 * moveScale;
      g.phase += g.swayT * moveScale;
      g.y += g.vy * moveScale;
    }
    // 边界约束：路径不超出左右边框
    g.x = constrain(g.x, 40, width-40);

    // 绘制（等比缩放到不超过48px的盒子）
    push(); if(g.fading) tint(255,g.alpha);
    if(g.img && g.img.width>0){
      const sw=g.img.width, sh=g.img.height, scale=(96/Math.max(sw,sh))*1.4; // 放大 2 倍，再×1.4
      const dw=sw*scale, dh=sh*scale;
      image(g.img, g.x-dw/2, g.y-dh/2, dw, dh);
      g.r=Math.min(dw,dh)*0.5*0.85;   // 碰撞半径随尺寸
    }else{ noStroke(); fill(200,255,200); circle(g.x,g.y,40); }
    pop(); noTint();

    // 台词：字号12，位于小鬼上方且不遮挡；命中后与小鬼同速渐隐
    if(g.say>0 || g.stuck || g.fading){
      push(); textAlign(CENTER,BOTTOM); textSize(12); fill(255, g.alpha ?? 255);
      const ty = g.y - (g.r + 40);
      text(g.def.line||"", g.x, ty);
      pop();
      if(g.say>0) g.say--;
    }

    // 符纸碰撞（仅当小鬼“完全”进入黑条下方，且仍在 PLAY 状态时才判定）
    if(state==="PLAY" && (g.y - g.r) > HIT_ACTIVE_Y){
      for(let s of spells){ if(!s.alive||g.hitLocked) continue; let dx=s.x-g.x, dy=s.y-g.y;
        if(dx*dx+dy*dy < g.r*g.r){
          // 应用效果
          applyEffect(g.def);
          // 锁定：显示台词并停留0.5秒，随后符纸/小鬼/台词同速渐隐
          g.hitLocked=true; g.stuck=true; g.freezeUntil=millis()+500; g.fading=false; g.alpha=255; g.say=9999; g.fadeStartAt=0; if(!g.fadeDuration) g.fadeDuration=700;
          s.stuck=true; s.link=g; s.trail=[]; s.x=g.x; s.y=g.y;
          lastHitName=g.def.name; lastHitAt=millis(); stats.hit++; stats.names.push(g.def.name);
          playHitSound();
        }
      }
    }
    // 命中后的停留与消失逻辑：先停留0.5s，再开始按时长渐隐
    if(g.stuck){
      if(!g.fading && millis()>=g.freezeUntil){ g.fading=true; g.fadeStartAt=millis(); }
      if(g.fading){
        const t = millis()-g.fadeStartAt;
        const ratio = constrain(t / (g.fadeDuration||700), 0, 1);
        g.alpha = 255 * (1 - ratio);
        if(ratio>=1){ g.alive=false; continue; }
      }
      continue; // 命中后不再移动
    }

    // 逃跑：只扣1并短暂红警，不结束游戏
    if(g.y>height+30){ g.alive=false; changeKarma(-ESCAPE_PENALTY); setShip("red",2000); if(warnS) warnS.play(); }

    // 碰飞船
    let dx=ship.x-g.x, dy=ship.y-g.y, rr=(g.r+28);
    if(dx*dx+dy*dy<rr*rr){ g.alive=false; changeKarma(-TOUCH_PENALTY); setShip("hit",2000); if(buzzS) buzzS.play(); }
  }
}

function playHitSound(){
  try{
    if(Array.isArray(hitS)){
      const s = random(hitS);
      if(s && s.play) s.play();
    } else if(hitS && hitS.play){
      hitS.play();
    }
  }catch(e){}
}

/* ============ 效果/结算/输入（原逻辑保留） ============ */
function setKarma(newVal, delta=0){
  lastKarmaDelta = delta;
  lastKarmaChangeAt = millis();
  karma = newVal;
}

function setTime(newVal, delta=0){
  lastTimeDelta = delta;
  lastTimeChangeAt = millis();
  timeLeft = newVal;
}
function addTimeSeconds(sec){
  const beforeSec = Math.ceil(timeMs/1000);
  timeMs = Math.max(0, timeMs + sec*1000);
  const afterSec = Math.ceil(timeMs/1000);
  setTime(afterSec, afterSec - beforeSec);
}

function applyEffect(def){
  switch(def.effect.type){
    case "KARMA_ADD": setKarma(karma + def.effect.value, +def.effect.value); pushFloatMsg('karma', `+${def.effect.value}`); break;
    case "KARMA_SUB": setKarma(karma - def.effect.value, -def.effect.value); pushFloatMsg('karma', `-${def.effect.value}`); break;
    case "KARMA_DOUBLE": { const nv=Math.floor(karma*2); setKarma(nv, nv - karma); pushFloatMsg('karma','😇'); break; }
    case "KARMA_HALF": { const nv=Math.floor(karma/2); setKarma(nv, nv - karma); pushFloatMsg('karma','💔'); break; }
    case "TIME_ADD": addTimeSeconds(def.effect.value); pushFloatMsg('time', `+${def.effect.value}`); break;
    case "FREEZE_SHIP": setShip("frozen", def.effect.value*1000); break;
    case "KARMA_RANDOM_30_100": { const nv=Math.floor(random(30,100)); setKarma(nv, nv - karma); pushFloatMsg('karma', '🎲'); break; }
    case "RESET_TIMER_AND_ZERO_KARMA":
      // 修改：不再结束游戏，改为时间与功德均重置为初始值
      pushFloatMsg('karma','🌀'); pushFloatMsg('time','🌀');
      timeMs = ROUND * 1000; setTime(ROUND, 0); setKarma(INIT_KARMA, 0); return;
  }
  if(karma<=0){ karma=0; endReason="KARMA"; endGame(); }
}

// 统一的功德变化入口（用于逃跑/碰撞扣分），并产生浮动提示
function changeKarma(delta){
  setKarma(karma + delta, delta);
  if(delta>0) pushFloatMsg('karma', `+${delta}`);
  else if(delta<0) pushFloatMsg('karma', `${delta}`); // delta 已含负号
  if(karma<=0){ karma=0; endReason="KARMA"; endGame(); }
}

// 添加/渲染浮动数字提示
function pushFloatMsg(kind, msg){
  floatMsgs.push({kind, msg, t:0});
}
function renderFloatMsgs(anchors){
  // 每帧更新并绘制，超时移除
  for(let i=floatMsgs.length-1;i>=0;i--){
    const f=floatMsgs[i];
    const a = anchors[f.kind];
    if(!a) continue;
    const t=f.t;
    const life=50; // 持续帧数
    const alpha = map(t,0,life,255,0);
    const y = a.y - map(t,0,life,0,18); // 逐渐向上漂移
    push();
    noStroke();
    const smsg = (f.msg==null?"":String(f.msg)).trim();
    const isPos = smsg.startsWith('+');
    const isNeg = smsg.startsWith('-');
    // 加分绿色，扣分红色，其他（如表情）用中性色黄
    if(isPos)      fill(80,255,140, alpha);
    else if(isNeg) fill(220,40,40, alpha);
    else           fill(240,220,80, alpha);
    textAlign(CENTER,CENTER); textSize(NUM_FONT);
    text(f.msg, a.x, y);
    pop();
    f.t++;
    if(f.t>life) floatMsgs.splice(i,1);
  }
}

function updateShipFixedY(){
  // 计算当前飞船图像的等比缩放后高度，设置 ship.y 使底部距屏幕 10px
  let img=imgShipIdle;
  if(ship.state==="hit"&&imgShipHit) img=imgShipHit;
  if(ship.state==="red"&&imgShipRed) img=imgShipRed;
  if(ship.state==="frozen"&&imgShipFrozen) img=imgShipFrozen;
  let dh = ship.h * SHIP_SCALE; // 默认高度（无图时）
  if(img && img.width>0){
    const sw=img.width, sh=img.height, box=Math.max(ship.w, ship.h);
    const s=box/Math.max(sw,sh) * SHIP_SCALE;
    dh = sh * s;
  }
  const cy = height - SHIP_BOTTOM_MARGIN - dh/2;
  ship.y = cy;
}

function drawShip(){
  if(ship.state!=="idle" && millis()>ship.until) ship.state="idle";
  let img=imgShipIdle;
  if(ship.state==="hit"&&imgShipHit) img=imgShipHit;
  if(ship.state==="red"&&imgShipRed) img=imgShipRed;
  if(ship.state==="frozen"&&imgShipFrozen) img=imgShipFrozen;

  if(img && img.width>0){
    // 等比放大到最大边（80）×1.5，按固定底边距渲染（ship.y 已在 updateShipFixedY 中更新为中心点）
    const sw=img.width, sh=img.height, box=Math.max(ship.w, ship.h);
    const s=box/Math.max(sw,sh) * SHIP_SCALE;
    const dw=sw*s, dh=sh*s;
    image(img, ship.x-dw/2, ship.y-dh/2, dw, dh);
  }
  else { noStroke(); fill(180,240,255); ellipse(ship.x, ship.y, ship.w, ship.h); }

  if(ship.state==="frozen"){
    push(); textAlign(CENTER,CENTER); textSize(28); fill(200,255,255); text("🥶", ship.x, ship.y-48); pop();
  }
}

function setShip(s,ms){ ship.state=s; ship.until=millis()+ms; }
function mouseDragged(){
  if(state==="END" && uiPage==='dex'){
    // 拖动滚动图鉴
    dexScroll = constrain(dexScroll - (mouseY - pmouseY), 0, dexScrollMax);
    return;
  }
  if(state!=="PLAY"||ship.state==="frozen") return; ship.x=constrain(mouseX,40,width-40);
}
function mouseMoved(){  if(state!=="PLAY"||ship.state==="frozen") return; ship.x=constrain(mouseX,40,width-40); }
function touchMoved(){
  if(state==="END" && uiPage==='dex'){
    if(touches && touches[0] && touches[0].y!=null && lastTouchY!=null){
      dexScroll = constrain(dexScroll - (touches[0].y - lastTouchY), 0, dexScrollMax);
    }
    if(touches && touches[0] && touches[0].y!=null) lastTouchY = touches[0].y;
    return false;
  }
  if(state!=="PLAY"||ship.state==="frozen") return; let tx=touches[0]?.x ?? mouseX; ship.x=constrain(tx,40,width-40); return false; }
function touchStarted(){ if(state==="END" && uiPage==='dex' && touches && touches[0]){ lastTouchY = touches[0].y; } }
function mouseWheel(e){ if(state==="END" && uiPage==='dex'){ dexScroll = constrain(dexScroll + e.delta, 0, dexScrollMax); } }
function mouseReleased(){ clickPos={x:mouseX,y:mouseY}; }
function touchEnded(){ clickPos={x:mouseX,y:mouseY}; return false; }

function endGame(){
  state="END"; ship.state=(endReason==="TIME")?"hit":"red"; ship.until=Number.MAX_SAFE_INTEGER;
  // 结束页音量按当前子页目标（主页 100%，图鉴/商店 50%）
  try{ syncBgmVolume(); }catch(e){}
}

function rank(sc){
  if(sc<=30) return {name:"纸扎见习生",desc:"拿反符纸的迷糊新人，建议每日多多强身健体～ \n\n福气值 ★★★★★ —— “诶诶？”"};
  if(sc<=80) return {name:"阴阳打工人",desc:"熟练掌握入门护灵技巧，修为尚可，继续努力！ \n\n福气值 ★★★★★ —— “来财～来财～”"};
  if(sc<=130) return {name:"福禄大队长",desc:"仙界对你略有耳闻，祝您早日大展宏图！ \n\n福气值 ★★★★★ —— “意料之中～”"};
  return {name:"天庭特派员",desc:"灵力爆棚，福气爆表，九转仙台有你名号～  \n\n福气值 ★★★★★ —— “不愧是我！”"};
}

function endScreen(){
  push(); fill(0,200); rect(0,0,width,height);
  if(uiPage===null){
    const r=rank(karma);
    fill(255); textAlign(CENTER,TOP);
    textSize(16); text("功德结算完成 · 灵力等级检测中…", width/2, 80);
    textSize(18); text(`累计功德值：${karma}`, width/2, 140);
    text(`收集小鬼数：${stats.hit}`, width/2, 170);
    textSize(20); text(`你的身份是：${r.name}`, width/2, 220);
    textSize(14); text(r.desc, width/2, 252); text(r.line, width/2, 276);
    button(width/2-120,340,240,48,"再来一局！",()=>restart());
    button(width/2-120,400,240,48,"本局收集小鬼图鉴",()=>{uiPage='dex';});
    button(width/2-120,460,240,48,"功德值兑换商店",()=>{uiPage='shop';});
  }else if(uiPage==='dex'){
    renderDexPage();
  }else if(uiPage==='shop'){
    renderShopPage();
  }
  pop();
}

function button(x,y,w,h,txt,cb){
  push(); stroke(255,120); noFill(); rect(x,y,w,h,12);
  noStroke(); fill(255); textAlign(CENTER,CENTER); textSize(16); text(txt, x+w/2, y+h/2); pop();
  if(clickPos && clickPos.x>x && clickPos.x<x+w && clickPos.y>y && clickPos.y<y+h){ if(cb) cb(); clickPos=null; }
}

function restart(){
  state="PLAY"; timeLeft=ROUND; timeMs=ROUND*1000; lastTickMs=0; karma=INIT_KARMA; ghosts=[]; spells=[]; stats={hit:0,names:[]}; ship.state="idle"; ship.until=0; endReason="";
  // 确保音频已解锁并播放 BGM；游戏内降至 50%
  tryUnlockAudioAndPlayBgm();
  if(bgm && bgm.setVolume) try{ if(typeof bgm.isPlaying!=='function' || bgm.isPlaying()) bgm.setVolume(0.5, 0.2); else { bgm.setLoop(true); bgm.setVolume(0.5); bgm.play(); } }catch(e){ bgm.setVolume(0.5); }
}
function renderDexPage(){
  push(); fill(0,240); rect(0,0,width,height); pop();
  // 标题
  push(); fill(255); textAlign(CENTER,TOP); textSize(22);
  text("本局收集小鬼图鉴", width/2, 20); pop();

  const list = Array.from(new Set(stats.names));
  if(list.length===0){
    push(); fill(255); textAlign(CENTER,TOP); textSize(14);
    text("（本局还没有收集到任何小鬼…）", width/2, 80); pop();
  } else {
    // 两列网格布局 + 滚动
    const margin=12, gap=12, contentTop=64, bottomSafe=80;
    const cols=2, cw=(width - margin*2 - gap)/cols, rowH=260; // 行高增大以容纳更大的图
    let col=0, row=0;
    // 计算滚动边界
    const rows = Math.ceil(list.length/cols);
    const contentH = rows * rowH;
    const viewH = height - contentTop - bottomSafe;
    dexScrollMax = max(0, contentH - viewH);
    dexScroll = constrain(dexScroll, 0, dexScrollMax);
    for(const name of list){
      const idx = window.GHOST_DEFS.findIndex(d=>d.name===name);
      const def = window.GHOST_DEFS[idx] || {line:"",effect:{type:""}};
      const imgPath = (ASSETS.ghost_images||[])[idx];
      // 卡片区域
      const x = margin + col*(cw+gap);
      const y = contentTop + row*rowH - dexScroll;
      // 仅绘制可视区域内的卡片，避免与底部返回按钮重叠
      if(y > contentTop + viewH) { col++; if(col>=cols){ col=0; row++; } continue; }
      if(y + rowH < contentTop) { col++; if(col>=cols){ col=0; row++; } continue; }
      // 图片（等比缩放至卡片宽度，最大高 100）
      let ih=0;
      if(imgPath){
        if(!dexCache[idx]) dexCache[idx]=loadImage(imgPath);
        const img=dexCache[idx];
        if(img && img.width>0){
          const s=Math.min(cw/img.width, (100*1.8)/img.height); // 放大 1.8 倍，同时不超出列宽
          const dw=img.width*s, dh=img.height*s; ih=dh;
          image(img, x + (cw-dw)/2, y, dw, dh);
        }
      }
      const eff=effectDesc(def.effect);
      // 文本：居中，上图下字（名字加粗；台词小号并加引号；功能同台词字号）
      push(); fill(255); textAlign(CENTER,TOP);
      const tx = x+cw/2; let ty = y + (ih||80) + 6;
      // 名称（加粗）
      textSize(16); textStyle(BOLD); text(name, tx, ty); ty+=20;
      // 台词（小一号并加引号）
      textStyle(NORMAL); textSize(12);
      const quote = def.line ? `“${def.line}”` : '';
      if(quote){ text(quote, tx, ty); ty+=16; }
      // 功能描述：去掉“功能：”，仅显示功德加减或特殊说明，字号与台词一致
      if(eff){ text(eff, tx, ty); }
      pop();

      col++; if(col>=cols){ col=0; row++; }
    }
  }
  // 返回按钮
  button(width/2-80, height-60, 160, 40, "点我返回", ()=>{ uiPage=null; });
}

function effectDesc(e){
  if(!e) return "";
  switch(e.type){
    // 只显示功德加减；特殊技能显示为指定短语
    case 'KARMA_ADD': return `功德 +${e.value}`;
    case 'KARMA_SUB': return `功德 -${e.value}`;
    case 'KARMA_DOUBLE': return '功德加倍';
    case 'KARMA_HALF': return '功德减半';
    case 'TIME_ADD': return `延寿${e.value}秒`;
    case 'FREEZE_SHIP': return `冻结${e.value}秒`;
    case 'KARMA_RANDOM_30_100': return '功德变为30-100任意值';
    case 'RESET_TIMER_AND_ZERO_KARMA': return '重置为初始时间与功德';
  }
  return '';
}
function renderShopPage(){
  push(); fill(0,240); rect(0,0,width,height); translate(width/2,height/2 - 100);
  rotate(radians(frameCount%360));
  if(imgShipIdle && imgShipIdle.width>0){
    const sw=imgShipIdle.width, sh=imgShipIdle.height, box=128;
    const s=box/Math.max(sw,sh) * SHIP_SCALE; const dw=sw*s, dh=sh*s;
    image(imgShipIdle, -dw/2, -dh/2, dw, dh);
  } else { noStroke(); fill(180,240,255); ellipse(0,0,128,128); }
  pop();
  push(); fill(255); textAlign(CENTER,CENTER); textSize(16);
  text("“这里什么都没有，你进来干嘛？”", width/2, height/2+20);
  pop();
  // 返回按钮
  button(width/2-80, height-80, 160, 40, "点我返回", ()=>{ uiPage=null; });
}
