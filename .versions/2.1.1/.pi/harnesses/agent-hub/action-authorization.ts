const brand:unique symbol=Symbol('one-use authority');
export type OneUseAuthority={readonly [brand]:true};
/** Private issuer ownership and object identity; hashes are binding data, never authority. */
export function createOneUseAuthority(){
 const grants=new WeakMap<object,string>();
 return {
  issue(key:string):OneUseAuthority {const grant=Object.freeze({[brand]:true as const});grants.set(grant,key);return grant;},
  consume(grant:OneUseAuthority|undefined,key:string):boolean {if(!grant||typeof grant!=='object'||grants.get(grant)!==key)return false;grants.delete(grant);return true;},
 };
}
