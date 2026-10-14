import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
// The pinned Next dependency already packages Acorn; no browser/parser dependency.
const {parse}=require('next/dist/compiled/acorn');
const englishUI=new Set(['Personal','General','Settings','Keyboard Shortcuts','Appearance','Notifications','Profile','Security and login','Account','Storage','Keyboard','Language','Language for the app UI','Back to app','Search','Search settings','Search languages','Languages','Theme','Appearance for the app UI','Auto detect','Light','Dark','Toggle sidebar','Navigation','Actions','App']);
export function localizeScript(source){
  const edits=[],ast=parse(source,{ecmaVersion:'latest'});
  function visit(node,parent,key){
    if(!node||typeof node!=='object')return;
    // Existing explicit bilingual help dictionaries remain authoritative.
    if(node.type==='VariableDeclarator'&&node.id?.name==='LANGUAGE_TEXT')return;
    if(node.type==='Literal'&&typeof node.value==='string'&&(/[\u0e00-\u0e7f]/.test(node.value)||englishUI.has(node.value)||[...englishUI].some(label=>node.value.includes('>'+label+'<')||node.value.includes('"'+label+'"')))&&
      !(['Property','MethodDefinition','PropertyDefinition'].includes(parent?.type)&&key==='key')&&
      !(parent?.type==='MemberExpression'&&key==='property')&&!parent?.directive){
      edits.push({start:node.start,end:node.end,text:'global.CRSI18n.text('+source.slice(node.start,node.end)+')'});return;
    }
    for(const [name,value] of Object.entries(node)){
      if(Array.isArray(value))for(const child of value)visit(child,node,name);
      else if(value&&typeof value==='object')visit(value,node,name);
    }
  }
  visit(ast);for(const edit of edits.sort((a,b)=>b.start-a.start))source=source.slice(0,edit.start)+edit.text+source.slice(edit.end);
  return source;
}
