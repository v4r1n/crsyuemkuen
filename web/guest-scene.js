/* Decorative renderer only. Public equipment and keyboard controls remain DOM.
 * mount(host) returns dispose(); it never fetches data, handles input authority,
 * or owns the borrow workflow. CSS is present before and without WebGL2. */
(function(global){
  'use strict';
  function mount(host){
    const canvas=document.createElement('canvas');
    canvas.className='guest-glass-scene';canvas.setAttribute('aria-hidden','true');
    host.prepend(canvas);host.dataset.renderer='css';
    const reduced=global.matchMedia('(prefers-reduced-motion:reduce)');
    const fine=global.matchMedia('(hover:hover) and (pointer:fine)');
    let gl=null,program=null,vao=null,buffer=null,frame=0,disposed=false,x=0,y=0;
    const shaders=[];
    function release(){
      if(!gl)return;
      if(program)gl.deleteProgram(program);if(buffer)gl.deleteBuffer(buffer);if(vao)gl.deleteVertexArray(vao);
      shaders.splice(0).forEach(shader=>gl.deleteShader(shader));program=buffer=vao=null;
    }
    function fallback(){cancelAnimationFrame(frame);frame=0;release();host.dataset.renderer='css';}
    function shader(type,source){
      const result=gl.createShader(type);shaders.push(result);gl.shaderSource(result,source);gl.compileShader(result);
      if(!gl.getShaderParameter(result,gl.COMPILE_STATUS))throw Error('Renderer unavailable');return result;
    }
    function paint(){
      frame=0;if(disposed||document.hidden||reduced.matches||!program||!host.isConnected||host.closest('[hidden]'))return;
      const bounds=host.getBoundingClientRect(),scale=Math.min(global.devicePixelRatio||1,1.25,1536/Math.max(bounds.width,1));
      canvas.width=Math.max(1,Math.round(bounds.width*scale));canvas.height=Math.max(1,Math.round(Math.min(bounds.height,360)*scale));
      gl.viewport(0,0,canvas.width,canvas.height);gl.useProgram(program);gl.bindVertexArray(vao);
      gl.uniform2f(gl.getUniformLocation(program,'resolution'),canvas.width,canvas.height);
      gl.uniform2f(gl.getUniformLocation(program,'pointer'),x,y);
      gl.uniform1f(gl.getUniformLocation(program,'dark'),document.documentElement.dataset.bsTheme==='dark'?1:0);
      gl.drawArrays(gl.TRIANGLES,0,6);host.dataset.renderer='webgl2';
    }
    function schedule(){if(!frame&&!disposed&&!document.hidden)frame=requestAnimationFrame(paint);}
    function start(){
      fallback();if(disposed||reduced.matches)return;
      try{
        gl=gl||canvas.getContext('webgl2',{alpha:true,antialias:false,depth:false,powerPreference:'low-power',preserveDrawingBuffer:false});
        if(!gl||gl.isContextLost())return;
        program=gl.createProgram();
        gl.attachShader(program,shader(gl.VERTEX_SHADER,'#version 300 es\nin vec2 position;out vec2 uv;void main(){uv=position*.5+.5;gl_Position=vec4(position,0.,1.);}'));
        gl.attachShader(program,shader(gl.FRAGMENT_SHADER,`#version 300 es
precision mediump float;in vec2 uv;out vec4 color;uniform vec2 resolution,pointer;uniform float dark;
float panel(vec2 p,vec2 size){vec2 q=abs(p)-size;return length(max(q,0.))+min(max(q.x,q.y),0.)-.035;}
void main(){
 vec2 p=(uv-.5)*vec2(resolution.x/resolution.y,1.);p+=pointer*.025;
 vec3 ink=vec3(0.004,.302,.545),pink=vec3(1.,.282,.541);vec3 light=mix(vec3(.8,.86,.91),vec3(.09,.15,.23),dark);
 vec3 tint=mix(ink,pink,smoothstep(-1.,1.,p.x));float glow=exp(-dot(p,p)*1.8)*.10;
 float a=0.;vec3 c=light;
 for(int i=0;i<3;i++){float n=float(i)-1.;vec2 q=p-vec2(n*.53,n*.12);q=mat2(.92,-.38,.38,.92)*q;
  float d=panel(q,vec2(.19,.22));float body=1.-smoothstep(-.006,.006,d);float rim=1.-smoothstep(.0,.012,abs(d));
  vec3 foil=mix(tint,vec3(1.),.5+.25*sin(q.x*8.+q.y*5.));c=mix(c,foil,body*.32);c=mix(c,foil,rim*.8);a=max(a,body*.24+rim*.35);
 }float alpha=min(1.,a+glow);color=vec4(c*alpha,alpha);
}`));
        gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error('Renderer unavailable');
        vao=gl.createVertexArray();gl.bindVertexArray(vao);buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
        gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
        const location=gl.getAttribLocation(program,'position');gl.enableVertexAttribArray(location);gl.vertexAttribPointer(location,2,gl.FLOAT,false,0,0);
        schedule();
      }catch{fallback();}
    }
    function move(event){if(!fine.matches||reduced.matches||event.pointerType==='touch')return;const b=host.getBoundingClientRect();x=(event.clientX-b.left)/Math.max(b.width,1)-.5;y=(event.clientY-b.top)/Math.max(b.height,1)-.5;schedule();}
    function leave(){x=y=0;schedule();}
    function lost(event){event.preventDefault();fallback();}
    function visibility(){if(document.hidden){cancelAnimationFrame(frame);frame=0;}else schedule();}
    host.addEventListener('pointermove',move);host.addEventListener('pointerleave',leave);
    canvas.addEventListener('webglcontextlost',lost);canvas.addEventListener('webglcontextrestored',start);
    document.addEventListener('visibilitychange',visibility);reduced.addEventListener('change',start);fine.addEventListener('change',leave);
    const resize=new ResizeObserver(schedule);resize.observe(host);
    const theme=new MutationObserver(schedule);theme.observe(document.documentElement,{attributes:true,attributeFilter:['data-bs-theme']});
    start();
    return function dispose(){
      disposed=true;fallback();resize.disconnect();theme.disconnect();host.removeEventListener('pointermove',move);host.removeEventListener('pointerleave',leave);
      canvas.removeEventListener('webglcontextlost',lost);canvas.removeEventListener('webglcontextrestored',start);
      document.removeEventListener('visibilitychange',visibility);reduced.removeEventListener('change',start);fine.removeEventListener('change',leave);
      if(gl&&!gl.isContextLost())gl.getExtension('WEBGL_lose_context')?.loseContext();canvas.remove();gl=null;
    };
  }
  global.CRSGuestScene=Object.freeze({mount});
})(window);
