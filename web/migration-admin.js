(function(global){
  'use strict';
  async function adminCall(method,args){
    const token=await global.CRS.auth.getSessionToken();
    const result=await global.CRS_SERVER_RPC(method,[token,...args]);
    if(!result.ok) throw new Error(result.error?.message||'ไม่สามารถอ่านข้อมูลได้');
    return result.data;
  }
  document.addEventListener('click',async event=>{
    const button=event.target.closest('[data-action="load-migration-archive"],[data-action="archive-next"],[data-action="inspect-storage-resource"],[data-action="cleanup-storage-queue"]');
    if(!button) return;
    button.disabled=true;
    try{
      if(button.dataset.action==='cleanup-storage-queue'){
        if(!global.confirm('ยืนยันล้างไฟล์ภาพที่อยู่ในคิวและไม่มีอุปกรณ์หรือ operation อ้างอิง? การล้างไฟล์จาก Storage ไม่ใช่การย้ายลงถังขยะ')) return;
        await adminCall('adminCleanupImages',[]);global.CRS.toast('ประมวลผลคิวล้างภาพแล้ว','success');return;
      }
      if(button.dataset.action==='inspect-storage-resource'){
        const popup=global.open('','crs-storage-preview','popup=yes,width=800,height=800');
        try {
          const data=await adminCall('adminGetImageResource',[button.dataset.fileId]);
          if(popup){popup.opener=null;popup.location.replace(data.signed_url);}
        }catch(error){popup?.close();throw error;}
        return;
      }
      const host=button.closest('[data-migration-archive]');
      const page=button.dataset.action==='archive-next'?Number(host.dataset.page||'1')+1:1;
      const data=await adminCall('adminListArchive',[{page}]);
      const target=host.querySelector('[data-archive-results]');target.replaceChildren();
      for(const record of data.items){
        const details=document.createElement('details'),summary=document.createElement('summary'),pre=document.createElement('pre');
        summary.textContent=record.sheet+' / แถว '+record.row_number+' / '+record.reason;
        pre.textContent=JSON.stringify(record.raw,null,2);pre.style.whiteSpace='pre-wrap';
        details.append(summary,pre);target.append(details);
      }
      host.dataset.page=String(page);host.querySelector('[data-action="archive-next"]').hidden=page*100>=data.total;
    }catch(error){global.CRS.toast(error.message,'danger');}
    finally{button.disabled=false;}
  });
})(window);
