(function(global){
  'use strict';
  const copy=global.CRS_UI_COPY,keys=Object.keys(copy).sort((a,b)=>b.length-a.length);
  const pattern=new RegExp(keys.map(key=>key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|'),'g');
  const english={General:'ทั่วไป',Settings:'การตั้งค่า','Keyboard Shortcuts':'คีย์ลัด',Appearance:'การแสดงผล',Notifications:'การแจ้งเตือน',Profile:'โปรไฟล์','Security and login':'ความปลอดภัยและการเข้าสู่ระบบ',Account:'บัญชี',Storage:'พื้นที่จัดเก็บ',Keyboard:'แป้นพิมพ์',Language:'ภาษา','Language for the app UI':'ภาษาของระบบ','Back to app':'กลับไปยังระบบ',Search:'ค้นหา','Search settings':'ค้นหาการตั้งค่า','Search languages':'ค้นหาภาษา',Languages:'ภาษา',Theme:'ธีม','Appearance for the app UI':'การแสดงผลของระบบ','Auto detect':'ตามระบบ',Light:'สว่าง',Dark:'มืด','Toggle sidebar':'ยุบ/ขยายแถบเมนู',Navigation:'การนำทาง',Actions:'การดำเนินการ',App:'ระบบ'};
  function effective(){return global.CRS?.language?.effective()||read();}
  function read(){
    try{const saved=localStorage.getItem('crs-ui-language');if(saved!==null)return saved==='en'?'en':'th';}catch{}
    try{if(sessionStorage.getItem('crs-ui-language-fallback')==='en')return 'en';}catch{}
    return 'th';
  }
  function text(value){
    if(effective()==='en')return value.replace(pattern,key=>copy[key]);
    value=value.replace(/>Personal</g,'>ส่วนตัว<');if(value==='Personal')return 'ส่วนตัว';
    const label=value.trim();if(english[label])return value.replace(label,english[label]);
    return value.replace(/>([^<>]+)</g,(all,label)=>english[label]?('>'+english[label]+'<'):all)
      .replace(/(aria-label|placeholder|title)="([^"]+)"/g,(all,name,label)=>english[label]?(name+'="'+english[label]+'"'):all);
  }
  // Called before bootstrap: only source-authored nodes/templates exist here.
  // Never walk live record content, names, descriptions or input values.
  function staticUI(root){
    for(const template of root.querySelectorAll('template'))staticUI(template.content);
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let node;
    while((node=walker.nextNode())){
      if(node.parentElement?.closest('script,style,noscript'))continue;
      node.nodeValue=text(node.nodeValue);
    }
    for(const node of root.querySelectorAll('[aria-label],[title],[placeholder]'))for(const name of ['aria-label','title','placeholder']){
      const value=node.getAttribute(name);if(value)node.setAttribute(name,text(value));
    }
  }
  function reload(){
    const selected=global.CRS.language.current();let persisted=false;
    try{persisted=localStorage.getItem('crs-ui-language')===selected;if(persisted)sessionStorage.removeItem('crs-ui-language-fallback');}catch{}
    if(!persisted)try{sessionStorage.setItem('crs-ui-language-fallback',selected);persisted=sessionStorage.getItem('crs-ui-language-fallback')===selected;}catch{}
    if(persisted)global.location.reload();
    else global.CRS.toast(text('ไม่สามารถบันทึกภาษาได้ กรุณาอนุญาตพื้นที่จัดเก็บของเบราว์เซอร์'),'warning');
  }
  global.CRSI18n=Object.freeze({text,read,staticUI,reload});
})(window);
