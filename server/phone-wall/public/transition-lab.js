(() => {
  const canvas = document.getElementById('wall');
  const context = canvas.getContext('2d');
  const $ = id => document.getElementById(id);
  const W = 930, H = 980, glyphs = ['♥', 'S', 'M', 'S', '♥'];
  const names = ['magnet', 'gravity', 'relay', 'storm'];
  const descriptions = {
    magnet: ['Magnetic letters', 'Letters overshoot their screens, then settle as if pulled by magnets.', 5.2, 'ASSEMBLING', 'SETTLED'],
    gravity: ['Gravity drop', 'Each letter falls into a screen, bounces, and sends a little shockwave.', 5.1, 'FALLING', 'LANDED'],
    relay: ['Signal relay', 'A flickering signal visits one phone at a time and leaves a letter behind.', 4.6, 'TRANSMITTING', 'DELIVERED'],
    storm: ['Pixel storm', 'Loose fragments spiral through the matrix and gather into a message.', 5.3, 'FORMING', 'FORMED'],
  };
  const phones = Array.from({length:15}, (_,index) => {
    const row = Math.floor(index / 5), col = index % 5;
    const x = 34 + col * 176, y = 38 + row * 307;
    const screen = {x:x+9,y:y+14,w:140,h:258};
    return {index,row,col,x,y,w:158,h:290,screen,cx:screen.x+screen.w/2,cy:screen.y+screen.h/2,glyph:glyphs[col]};
  });
  const relayOrder = [0,1,2,3,4,9,8,7,6,5,10,11,12,13,14];
  const relayPosition = new Map(relayOrder.map((index,position) => [index,position]));
  const clamp = (value,min=0,max=1) => Math.max(min,Math.min(max,value));
  const ease = value => 1-Math.pow(1-clamp(value),3);
  const rngFrom = seed => { let value=seed>>>0; return () => { value+=0x6D2B79F5; let x=value; x=Math.imul(x^(x>>>15),x|1); x^=x+Math.imul(x^(x>>>7),x|61); return ((x^(x>>>14))>>>0)/4294967296; }; };
  const freshSeed = () => crypto.getRandomValues(new Uint32Array(1))[0];
  let seed = freshSeed(), effect = 'magnet', scene, lastTime = 0, lastPaint = 0, frame = 0, tourTimer;
  const metrics = new Map();
  context.font = '100px Arial, Helvetica, sans-serif';
  for(const glyph of new Set(glyphs)){
    const ink=context.measureText(glyph);
    metrics.set(glyph,{width:ink.width,ascent:ink.actualBoundingBoxAscent||78,descent:ink.actualBoundingBoxDescent||12});
  }

  function reset(nextEffect=effect,newSeed=seed){
    clearTimeout(tourTimer);
    effect=nextEffect;seed=newSeed>>>0;
    const random=rngFrom(seed),chaos=Number($('chaos').value)/100;
    const hue=Math.floor(random()*360);
    const colors=Array.from({length:3},(_,row)=>`hsl(${Math.round((hue+row*120)%360)} 89% 66%)`);
    const objects=phones.map(phone=>{
      const spread=160+chaos*700;
      return {
        ...phone,x:phone.cx+(random()-.5)*spread*2,y:phone.cy+(random()-.5)*spread*2,
        vx:(random()-.5)*450,vy:(random()-.5)*450,angle:(random()-.5)*2.6,
        hit:0,trail:[],
      };
    });
    if(effect==='gravity')for(const object of objects){
      object.x=object.cx+(random()-.5)*(25+chaos*260);
      object.y=-120-random()*(200+chaos*700)-object.row*70;
      object.vx=(random()-.5)*(40+chaos*180);object.vy=0;object.angle=(random()-.5)*chaos;
    }
    const shards=phones.flatMap(phone=>Array.from({length:12+Math.round(chaos*8)},()=>({
      phone,x:W/2+(random()-.5)*W*1.6,y:H/2+(random()-.5)*H*1.6,
      tx:phone.screen.x+random()*phone.screen.w,ty:phone.screen.y+random()*phone.screen.h,
      radius:100+random()*480,phase:random()*Math.PI*2,size:2+random()*7,
    })));
    scene={effect,random,chaos,colors,objects,shards,elapsed:0,playing:true,duration:descriptions[effect][2]};
    document.querySelectorAll('.effect').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.effect===effect)));
    $('effect-title').textContent=descriptions[effect][0];
    $('effect-description').textContent=descriptions[effect][1];
    $('seed').textContent=`SEED ${seed.toString(16).padStart(8,'0').toUpperCase()}`;
    $('phase').textContent=descriptions[effect][3];
    $('progress').style.width='0%';
    lastTime=0;lastPaint=0;
    if(!frame)frame=requestAnimationFrame(tick);
  }

  function update(dt){
    if(effect==='magnet')for(const object of scene.objects){
      const spring=8.5+scene.chaos*2.5, drag=Math.exp(-4.4*dt);
      object.vx=(object.vx+(object.cx-object.x)*spring*dt)*drag;
      object.vy=(object.vy+(object.cy-object.y)*spring*dt)*drag;
      object.x+=object.vx*dt;object.y+=object.vy*dt;
      object.angle+=(0-object.angle)*Math.min(1,dt*5);
      object.trail.push([object.x,object.y]);if(object.trail.length>8)object.trail.shift();
    }
    if(effect==='gravity')for(const object of scene.objects){
      object.vy+=1200*dt;
      object.vx+=(object.cx-object.x)*12*dt;
      object.vx*=Math.exp(-3.8*dt);
      object.x+=object.vx*dt;object.y+=object.vy*dt;
      if(object.y>=object.cy&&object.vy>0){object.y=object.cy;object.vy=-object.vy*.43;object.hit=1;}
      object.hit=Math.max(0,object.hit-dt*1.4);
      object.angle+=(0-object.angle)*Math.min(1,dt*4);
    }
  }

  function glyphAt(glyph,x,y,color,phone,scale=1,angle=0,alpha=1){
    const ink=metrics.get(glyph);
    context.save();context.translate(x,y);context.rotate(angle);
    context.scale(phone.screen.w*.82/ink.width*scale,phone.screen.h*.78/(ink.ascent+ink.descent)*scale);
    context.font='100px Arial, Helvetica, sans-serif';context.textBaseline='alphabetic';context.textAlign='left';
    context.globalAlpha*=alpha;context.fillStyle=color;
    context.shadowColor=color;context.shadowBlur=8;
    context.fillText(glyph,-ink.width/2,(ink.ascent-ink.descent)/2);
    context.restore();
  }

  function phoneContents(phone,progress){
    const color=scene.colors[phone.row],s=phone.screen;
    context.fillStyle='#060d0c';context.fillRect(s.x,s.y,s.w,s.h);
    const glow=context.createRadialGradient(phone.cx,phone.cy,3,phone.cx,phone.cy,s.h*.65);
    glow.addColorStop(0,`hsla(${(scene.colors[phone.row].match(/\d+/)||[90])[0]} 75% 40% / .22)`);
    glow.addColorStop(1,'#06100c00');context.fillStyle=glow;context.fillRect(s.x,s.y,s.w,s.h);

    if(effect==='magnet'||effect==='gravity'){
      for(const object of scene.objects){
        if(Math.abs(object.x-phone.cx)>220||Math.abs(object.y-phone.cy)>320)continue;
        if(effect==='magnet'&&object.trail.length>1){
          context.beginPath();context.moveTo(...object.trail[0]);
          for(const point of object.trail.slice(1))context.lineTo(...point);
          context.strokeStyle=scene.colors[object.row];context.globalAlpha=.2;context.lineWidth=4;context.stroke();context.globalAlpha=1;
        }
        glyphAt(object.glyph,object.x,object.y,scene.colors[object.row],object,1,object.angle);
        if(effect==='gravity'&&object.hit>0){
          context.beginPath();context.arc(object.cx,object.cy,25+(1-object.hit)*125,0,Math.PI*2);
          context.strokeStyle=scene.colors[object.row];context.globalAlpha=object.hit*.45;context.lineWidth=3;context.stroke();context.globalAlpha=1;
        }
      }
    }else if(effect==='relay'){
      const position=relayPosition.get(phone.index),head=progress*16-1.2;
      const reveal=clamp((head-position+1)*3);
      if(reveal>0){
        const jump=position>head-.7&&position<head+.8?scene.chaos*8:0;
        glyphAt(phone.glyph,phone.cx+Math.sin(scene.elapsed*48+position)*jump,phone.cy,color,phone,1,0,reveal);
      }
      const near=1-Math.abs(head-position);
      if(near>0){
        context.fillStyle=color;context.globalAlpha=near*.12;
        context.fillRect(s.x,s.y,s.w,s.h);context.globalAlpha=1;
        for(let i=0;i<5+scene.chaos*10;i++){
          const y=s.y+scene.random()*s.h;
          context.fillStyle=color;context.globalAlpha=near*(.15+scene.random()*.3);
          context.fillRect(s.x+scene.random()*s.w*.45,y,s.w*(.2+scene.random()*.6),1+scene.random()*4);
        }
        context.globalAlpha=1;
      }
    }else{
      const settle=ease(progress),swirl=(1-settle)*scene.chaos;
      for(const shard of scene.shards){
        if(shard.phone!==phone)continue;
        const x=shard.x+(shard.tx-shard.x)*settle+Math.cos(shard.phase+scene.elapsed*3)*shard.radius*swirl;
        const y=shard.y+(shard.ty-shard.y)*settle+Math.sin(shard.phase+scene.elapsed*3)*shard.radius*swirl;
        context.save();context.translate(x,y);context.rotate(shard.phase+scene.elapsed*2*(1-settle));
        context.fillStyle=color;context.globalAlpha=(1-settle)*.8;
        context.fillRect(-shard.size/2,-shard.size/2,shard.size*2,shard.size/2);
        context.restore();
      }
      glyphAt(phone.glyph,phone.cx,phone.cy,color,phone,1,0,clamp((progress-.55)/.4));
    }
    context.fillStyle='#ffffff08';for(let y=s.y+6;y<s.y+s.h;y+=8)context.fillRect(s.x,y,s.w,1);
  }

  function draw(){
    const progress=clamp(scene.elapsed/scene.duration);
    context.clearRect(0,0,W,H);
    const bg=context.createLinearGradient(0,0,W,H);bg.addColorStop(0,'#0b1815');bg.addColorStop(1,'#112723');
    context.fillStyle=bg;context.fillRect(0,0,W,H);
    context.strokeStyle='#ffffff08';context.lineWidth=1;
    for(let x=0;x<W;x+=24){context.beginPath();context.moveTo(x,0);context.lineTo(x,H);context.stroke();}
    for(let y=0;y<H;y+=24){context.beginPath();context.moveTo(0,y);context.lineTo(W,y);context.stroke();}
    for(const phone of phones){
      context.save();context.shadowColor='#000b';context.shadowBlur=17;context.fillStyle='#182723';
      context.beginPath();context.roundRect(phone.x,phone.y,phone.w,phone.h,20);context.fill();context.restore();
      context.strokeStyle='#61786b';context.lineWidth=1.5;
      context.beginPath();context.roundRect(phone.x+.75,phone.y+.75,phone.w-1.5,phone.h-1.5,20);context.stroke();
      context.save();context.beginPath();context.roundRect(phone.screen.x,phone.screen.y,phone.screen.w,phone.screen.h,7);context.clip();
      phoneContents(phone,progress);context.restore();
      context.fillStyle='#70857a';context.beginPath();context.arc(phone.x+phone.w/2,phone.y+6,2,0,Math.PI*2);context.fill();
      context.fillStyle='#81968b';context.font='9px ui-monospace, Menlo, monospace';context.textAlign='center';
      context.fillText(String(phone.index+1).padStart(2,'0'),phone.x+phone.w/2,phone.y+phone.h-5);
    }
    $('progress').style.width=`${Math.round(progress*100)}%`;
    $('phase').textContent=progress>=1?descriptions[effect][4]:descriptions[effect][3];
  }

  function tick(now){
    frame=0;
    if(document.hidden){lastTime=now;frame=requestAnimationFrame(tick);return;}
    if(lastPaint&&now-lastPaint<30){frame=requestAnimationFrame(tick);return;}
    const dt=lastTime?Math.min(.06,(now-lastTime)/1000)*Number($('speed').value):0;
    lastTime=now;lastPaint=now;
    if(scene.playing){
      scene.elapsed=Math.min(scene.duration,scene.elapsed+dt);update(dt);
      if(scene.elapsed>=scene.duration&&['magnet','gravity'].includes(effect))for(const object of scene.objects){object.x=object.cx;object.y=object.cy;object.angle=0;object.hit=0;object.trail=[];}
    }
    draw();
    if(scene.elapsed>=scene.duration){
      scene.playing=false;
      if($('tour').checked)tourTimer=setTimeout(()=>reset(names[(names.indexOf(effect)+1)%names.length],freshSeed()),800);
    }else frame=requestAnimationFrame(tick);
  }

  document.querySelectorAll('.effect').forEach(button=>button.addEventListener('click',()=>reset(button.dataset.effect,seed)));
  $('reseed').addEventListener('click',()=>reset(effect,freshSeed()));
  $('replay').addEventListener('click',()=>reset(effect,seed));
  $('chaos').addEventListener('input',()=>{$('chaos-value').textContent=`${$('chaos').value}%`;});
  $('chaos').addEventListener('change',()=>reset(effect,seed));
  $('speed').addEventListener('input',()=>{$('speed-value').textContent=`${Number($('speed').value).toFixed(1)}×`;});
  $('tour').addEventListener('change',()=>{if($('tour').checked&&!scene.playing)reset(names[(names.indexOf(effect)+1)%names.length],freshSeed());else clearTimeout(tourTimer);});
  window.addEventListener('keydown',event=>{
    if(event.target instanceof HTMLInputElement)return;
    const index=Number(event.key)-1;
    if(index>=0&&index<names.length)reset(names[index],seed);
    else if(event.code==='Space'){event.preventDefault();reset(effect,seed);}
    else if(event.key.toLowerCase()==='r')reset(effect,freshSeed());
  });
  reset();
})();
