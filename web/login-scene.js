/* Decorative 3D glass only: no data/auth/workflow access or animation clock.
 * Event-driven paints, at most 30fps while a fine pointer actually moves. */
(function(global){
  'use strict';
  function mount(host){
    const canvas=document.createElement('canvas'),surface=host.closest('.login-layout');
    canvas.className='login-glass-scene';canvas.setAttribute('aria-hidden','true');host.prepend(canvas);host.dataset.renderer='css';
    const media=global.matchMedia('(min-width:768px) and (hover:hover) and (pointer:fine) and (prefers-reduced-motion:no-preference)');
    let gl=null,program=null,vao=null,buffer=null,frame=0,timer=0,last=0,disposed=false,pointer=[0,0];
    const shaders=[];
    function cancel(){cancelAnimationFrame(frame);clearTimeout(timer);frame=timer=0;}
    function release(){
      if(!gl)return;if(program)gl.deleteProgram(program);if(buffer)gl.deleteBuffer(buffer);if(vao)gl.deleteVertexArray(vao);
      shaders.splice(0).forEach(shader=>gl.deleteShader(shader));program=buffer=vao=null;
    }
    function fallback(){cancel();release();host.dataset.renderer='css';}
    function shader(type,source){
      const value=gl.createShader(type);shaders.push(value);gl.shaderSource(value,source);gl.compileShader(value);
      if(!gl.getShaderParameter(value,gl.COMPILE_STATUS))throw Error('Decorative renderer unavailable');return value;
    }
    function paint(){
      frame=0;if(disposed||document.hidden||!media.matches||!program||!host.isConnected||host.closest('[hidden]'))return;
      const bounds=host.getBoundingClientRect();if(!bounds.width||!bounds.height)return;
      const scale=Math.min(global.devicePixelRatio||1,1.25,768/bounds.width,512/bounds.height);
      const width=Math.max(1,Math.round(bounds.width*scale)),height=Math.max(1,Math.round(bounds.height*scale));
      if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
      gl.viewport(0,0,width,height);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
      gl.useProgram(program);gl.bindVertexArray(vao);
      gl.uniform1f(gl.getUniformLocation(program,'aspect'),width/height);
      gl.uniform2f(gl.getUniformLocation(program,'pointer'),...pointer);
      gl.uniform1f(gl.getUniformLocation(program,'dark'),document.documentElement.dataset.bsTheme==='dark'?1:0);
      for(let i=2;i>=0;i--){gl.uniform1f(gl.getUniformLocation(program,'layer'),i);gl.drawArrays(gl.TRIANGLES,0,96);}
      host.dataset.renderer='webgl2';last=performance.now();
    }
    function schedule(){
      if(frame||timer||disposed||document.hidden||!media.matches||!program)return;
      const wait=Math.max(0,34-(performance.now()-last));
      if(wait)timer=setTimeout(()=>{timer=0;if(!disposed&&!document.hidden)frame=requestAnimationFrame(paint);},wait);
      else frame=requestAnimationFrame(paint);
    }
    function start(){
      fallback();if(disposed||document.hidden||!media.matches||!host.isConnected||host.closest('[hidden]'))return;
      try{
        gl=gl||canvas.getContext('webgl2',{alpha:true,antialias:false,depth:true,premultipliedAlpha:true,powerPreference:'low-power'});
        if(!gl||gl.isContextLost())return;
        program=gl.createProgram();
        gl.attachShader(program,shader(gl.VERTEX_SHADER,`#version 300 es
in vec3 position,normal;out vec3 n,point;uniform vec2 pointer;uniform float aspect,layer;
mat3 rx(float a){float c=cos(a),s=sin(a);return mat3(1.,0.,0.,0.,c,s,0.,-s,c);}
mat3 ry(float a){float c=cos(a),s=sin(a);return mat3(c,0.,-s,0.,1.,0.,s,0.,c);}
mat3 rz(float a){float c=cos(a),s=sin(a);return mat3(c,s,0.,-s,c,0.,0.,0.,1.);}
void main(){
 float side=layer==1.?-1.:1.;float size=layer==0.?1.25:.65;
 mat3 rotation=ry(.4+pointer.x*.16+layer*.15)*rx(-.2+pointer.y*.12)*rz(layer==0.?-.15:side*.4);
 vec3 p=rotation*position*size;n=rotation*normal;point=position;
 p+=layer==0.?vec3(pointer*.04,-3.6):vec3(side*1.22,side*.48,-4.2);
 gl_Position=vec4(p.x*1.7/aspect,p.y*1.7,-1.02*p.z-.202,-p.z);
}`));
        gl.attachShader(program,shader(gl.FRAGMENT_SHADER,`#version 300 es
precision highp float;in vec3 n,point;out vec4 color;uniform vec2 pointer;uniform float dark,layer;
void main(){
 vec3 normal=normalize(n),light=normalize(vec3(-.6+pointer.x*.3,.9-pointer.y*.3,1.8));
 float diffuse=max(dot(normal,light),0.),fresnel=pow(1.-abs(normal.z),2.);
 float spec=pow(max(dot(reflect(-light,normal),vec3(0.,0.,1.)),0.),28.);
 float edge=smoothstep(.80,1.,max(abs(point.x),abs(point.y)));
 vec3 blue=vec3(.004,.302,.545),pink=vec3(1.,.282,.541),ice=vec3(.796,.859,.91);
 float foil=.5+.5*sin(point.x*2.+normal.y*3.+pointer.x*.5+layer);
 vec3 tint=mix(blue,pink,foil*.52);tint=mix(tint,ice,.38+diffuse*.27);
 tint=mix(tint,vec3(1.),clamp(spec*.65+edge*.28+fresnel*.25,0.,.9));
 float alpha=clamp(.35+diffuse*.2+edge*.25+fresnel*.2+dark*.08,0.,.88);
 color=vec4(tint*alpha,alpha);
}`));
        gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error('Decorative renderer unavailable');
        // Octagonal beveled prism: 16 face + 16 side triangles, static mesh.
        const ring=[[-.72,-1],[.72,-1],[1,-.72],[1,.72],[.72,1],[-.72,1],[-1,.72],[-1,-.72]],vertices=[];
        const vertex=(p,n)=>vertices.push(...p,...n);
        for(let i=0;i<8;i++){
          const a=ring[i],b=ring[(i+1)%8],normal=[b[1]-a[1],a[0]-b[0],0];
          const length=Math.hypot(...normal);normal[0]/=length;normal[1]/=length;
          vertex([0,0,.12],[0,0,1]);vertex([...a,.12],[0,0,1]);vertex([...b,.12],[0,0,1]);
          vertex([0,0,-.12],[0,0,-1]);vertex([...b,-.12],[0,0,-1]);vertex([...a,-.12],[0,0,-1]);
          for(const p of [[...a,.12],[...a,-.12],[...b,.12],[...b,.12],[...a,-.12],[...b,-.12]])vertex(p,normal);
        }
        vao=gl.createVertexArray();gl.bindVertexArray(vao);buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
        gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(vertices),gl.STATIC_DRAW);
        for(const [name,offset]of[['position',0],['normal',12]]){const at=gl.getAttribLocation(program,name);gl.enableVertexAttribArray(at);gl.vertexAttribPointer(at,3,gl.FLOAT,false,24,offset);}
        gl.enable(gl.DEPTH_TEST);gl.enable(gl.CULL_FACE);gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
        schedule();
      }catch{fallback();}
    }
    function move(event){
      if(!media.matches||event.pointerType==='touch'||document.hidden)return;
      const bounds=surface.getBoundingClientRect();
      pointer=[Math.max(-1,Math.min(1,2*(event.clientX-bounds.left)/Math.max(bounds.width,1)-1)),
        Math.max(-1,Math.min(1,2*(event.clientY-bounds.top)/Math.max(bounds.height,1)-1))];schedule();
    }
    function reset(){pointer=[0,0];schedule();}
    function lost(event){event.preventDefault();fallback();}
    function visibility(){if(document.hidden)cancel();else if(!program)start();else schedule();}
    surface.addEventListener('pointermove',move);surface.addEventListener('pointerleave',reset);global.addEventListener('blur',reset);
    canvas.addEventListener('webglcontextlost',lost);canvas.addEventListener('webglcontextrestored',start);
    document.addEventListener('visibilitychange',visibility);media.addEventListener('change',start);
    const resize=new ResizeObserver(schedule);resize.observe(host);
    const theme=new MutationObserver(schedule);theme.observe(document.documentElement,{attributes:true,attributeFilter:['data-bs-theme']});
    start();
    return function dispose(){
      if(disposed)return;disposed=true;fallback();resize.disconnect();theme.disconnect();
      surface.removeEventListener('pointermove',move);surface.removeEventListener('pointerleave',reset);global.removeEventListener('blur',reset);
      canvas.removeEventListener('webglcontextlost',lost);canvas.removeEventListener('webglcontextrestored',start);
      document.removeEventListener('visibilitychange',visibility);media.removeEventListener('change',start);
      if(gl&&!gl.isContextLost())gl.getExtension('WEBGL_lose_context')?.loseContext();canvas.remove();gl=null;
    };
  }
  global.CRSLoginScene=Object.freeze({mount});
})(window);
