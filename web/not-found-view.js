'use client';
import {useEffect,useState} from 'react';

export default function NotFoundView({homeUrl}) {
  const [language,setLanguage]=useState('th'),[theme,setTheme]=useState('light');
  const en=language==='en';
  useEffect(()=>{
    let preference='system';
    try {
      if(localStorage.getItem('crs-ui-language')==='en')setLanguage('en');
      const saved=localStorage.getItem('crs-theme');
      if(['light','dark','system'].includes(saved))preference=saved;
    }catch{/* Preferences are optional, never identity. */}
    const media=matchMedia('(prefers-color-scheme: dark)');
    const sync=()=>setTheme(preference==='system'?(media.matches?'dark':'light'):preference);
    sync();media.addEventListener('change',sync);
    return ()=>media.removeEventListener('change',sync);
  },[]);
  useEffect(()=>{document.documentElement.lang=language;document.documentElement.dataset.bsTheme=theme;},[language,theme]);
  function changeLanguage(){const next=en?'th':'en';setLanguage(next);try{localStorage.setItem('crs-ui-language',next);}catch{/* Page-local fallback. */}}
  return <main className="not-found-page" aria-labelledby="not-found-title">
    <div className="not-found-orbit" aria-hidden="true"><span /><span /><span /></div>
    <section className="not-found-card">
      <div className="not-found-controls"><button type="button" onClick={changeLanguage} aria-label={en?'Language: English. Switch to Thai':'ภาษา: ไทย เปลี่ยนเป็นอังกฤษ'}>{en?'EN':'TH'}</button></div>
      <img className="not-found-logo" src="/brand/icon-yuemkuen.png" width="72" height="72" alt="" />
      <p className="not-found-brand">CRS Yuem-Kuen</p>
      <p className="not-found-code" aria-hidden="true">404</p>
      <h1 id="not-found-title">{en?'Page not found':'ไม่พบหน้าที่คุณต้องการ'}</h1>
      <p className="not-found-copy">{en?'This link may have moved or no longer exist. Return home to browse equipment.':'ลิงก์นี้อาจเปลี่ยนไปหรือไม่มีอยู่แล้ว กลับหน้าแรกเพื่อค้นหาอุปกรณ์ได้เลย'}</p>
      <a className="not-found-home" href={homeUrl}><span aria-hidden="true">←</span>{en?'Back to home':'กลับหน้าแรก'}</a>
    </section>
  </main>;
}
