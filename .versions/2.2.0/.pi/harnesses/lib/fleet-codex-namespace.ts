/** Canonical namespace identity; import-free for cached UI and transport users. */
export const namespaceKey=(c:{readonly hostProfile:string;readonly principal:string;readonly threadId:string})=>JSON.stringify([c.hostProfile,c.principal,c.threadId]);
