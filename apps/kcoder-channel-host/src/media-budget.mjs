import { requireValue } from './errors.mjs';

export class MediaBudget {
  constructor(maxBytes){this.maxBytes=maxBytes;this.reserved=0;}
  reserve(bytes){
    requireValue(Number.isSafeInteger(bytes)&&bytes>=0&&this.reserved+bytes<=this.maxBytes,'MEDIA_CAPACITY_EXCEEDED');
    this.reserved+=bytes;let active=true;
    return {release:()=>{if(active){active=false;this.reserved-=bytes;}}};
  }
}
export const mediaDiskBudget=new MediaBudget(512*1024*1024);
export const mediaBufferBudget=new MediaBudget(160*1024*1024);
