/** Visible programmatic views carry the advisory as well as untouched original evidence. */
export function damageResultView<T extends {content:readonly any[];structuredContent?:unknown}>(event:T,text:string,metadata:unknown,key:'damageGuard'|'fileDiscovery'='damageGuard'):T{
 const original=event.structuredContent;
 const advisory={metadata,text};
 let structuredContent:unknown=original;
 if(typeof original==='string')structuredContent=original+'\n'+text;
 else if(original!==undefined){
  const plain=!!original&&typeof original==='object'&&!Array.isArray(original)&&Object.getPrototypeOf(original)===Object.prototype;
  // D8 composes onto the D6 view without replacing its warning or original slot.
  if(key==='fileDiscovery'&&plain&&!Object.hasOwn(original as object,key))structuredContent={...original as object,[key]:advisory};
  else structuredContent=plain&&!Object.hasOwn(original as object,key)&&!Object.hasOwn(original as object,'originalStructuredContent')?{...original as object,originalStructuredContent:original,[key]:advisory}:{originalStructuredContent:original,[key]:advisory};
 }
 // Strings retain their declared native output type; the emission-local evidence
 // snapshot and untouched original text block retain the exact original string.
 return {...event,content:[...event.content,{type:'text',text}],structuredContent} as T;
}
