import {Buffer} from 'node:buffer';

/** Pure shared question address contract: no host, files, grants or ID normalization. */
export const MAX_TOOL_CALL_ID_LENGTH=256;
const MAX_QUESTION_ID_LENGTH=96;
const legacyPrefix='fleet:question/';
const versionedPrefix='fleet:question:v2/';
const questionId=/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const legacyToolId=/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const validQuestionId=(value:unknown):value is string=>typeof value==='string'&&questionId.test(value);
export const MAX_QUESTION_REFERENCE_LENGTH=versionedPrefix.length+MAX_QUESTION_ID_LENGTH+1+Math.ceil(2*MAX_TOOL_CALL_ID_LENGTH*4/3);
export const validOpaqueToolCallId=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=MAX_TOOL_CALL_ID_LENGTH&&!/[\u0000-\u001f\u007f]/u.test(value);

export function encodeQuestionReference(id:string,toolCallId:string):string{
 if(!validQuestionId(id)||!validOpaqueToolCallId(toolCallId))throw Error('invalid_question_reference');
 // Keep old addresses/digests stable. v2 is only for IDs legacy cannot represent.
 if(legacyToolId.test(toolCallId))return legacyPrefix+id+'/'+toolCallId;
 // UTF-8 replaces lone surrogates; UTF-16LE preserves every permitted JS code unit.
 return versionedPrefix+id+'/'+Buffer.from(toolCallId,'utf16le').toString('base64url');
}
export function decodeQuestionReference(reference:unknown):{questionId:string;toolCallId:string}|null{
 if(typeof reference!=='string'||reference.length>MAX_QUESTION_REFERENCE_LENGTH)return null;
 if(reference.startsWith(versionedPrefix)){
  const parts=reference.slice(versionedPrefix.length).split('/');
  if(parts.length!==2||!validQuestionId(parts[0])||!/^[-_A-Za-z0-9]+$/.test(parts[1]))return null;
  const bytes=Buffer.from(parts[1],'base64url');
  if(bytes.length===0||bytes.length>2*MAX_TOOL_CALL_ID_LENGTH||bytes.length%2!==0||bytes.toString('base64url')!==parts[1])return null;
  const toolCallId=bytes.toString('utf16le');
  if(!validOpaqueToolCallId(toolCallId)||encodeQuestionReference(parts[0],toolCallId)!==reference)return null;
  return {questionId:parts[0],toolCallId};
 }
 if(!reference.startsWith(legacyPrefix)||reference.length>512)return null;
 const parts=reference.slice(legacyPrefix.length).split('/');
 if(parts.length!==2||!validQuestionId(parts[0])||!legacyToolId.test(parts[1]))return null;
 return {questionId:parts[0],toolCallId:parts[1]};
}
/** Preserve the old generic bound; only canonical v2 questions get the derived bound. */
export function withinFleetReferenceLimit(kind:string,reference:unknown):reference is string{
 if(typeof reference!=='string')return false;
 if(kind==='question'&&reference.startsWith(versionedPrefix))return decodeQuestionReference(reference)!==null;
 return reference.length<=512;
}
