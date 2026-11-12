/** Native notification stream and fixed desktop activation honor caller session access. */
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { expect,it,vi } from 'vitest'
import { Notifications } from '../src/runtime/index.ts'
import type { NotificationDeliveryFrame, NotificationSettings } from '../src/runtime/types.ts'
it('streams current preferences without exposing hidden sessions and only activates permitted targets',async()=>{
 const ctx=new Context()
 const activateDesktop=vi.fn(async()=>true)
 let settings:NotificationSettings={desktop:true,volume:80,completed:{enabled:true,sound:'chime'},interrupted:{enabled:true,sound:'alert'},question:{enabled:true,sound:'soft'},approval:{enabled:true,sound:'double'}}
 const plugin=ctx.plugin(Notifications,{activateDesktop,readSettings:()=>settings,allowsSession:(_caller:Context,id:string)=>id==='visible',observe:async function*(signal:AbortSignal):AsyncIterable<NotificationDeliveryFrame>{signal.throwIfAborted();yield {epoch:'test',cursor:2,baseline:false,settings,events:[{id:'a',sessionId:'visible',kind:'completed'},{id:'b',sessionId:'hidden',kind:'interrupted'}]};settings={...settings,desktop:false,volume:95};yield {epoch:'test',cursor:3,baseline:false,settings,events:[]}}})
 await plugin
 try{
  const service=ctx.get('dshNotifications') as Notifications
  expect(remoteMethods(service).map(row=>row.method).sort()).toEqual(['acknowledgeDesktop','activateDesktop','closeDesktop','desktopEvents','events','showDesktop'])
  const frames:NotificationDeliveryFrame[]=[]
  for await(const frame of service.events(new AbortController().signal))frames.push(frame)
  expect(frames[0]!.events.map(event=>event.id)).toEqual(['a'])
  expect(frames[0]!.settings.desktop).toBe(true)
  expect(frames[0]!.settings.volume).toBe(80)
  expect(frames[1]!.settings.volume).toBe(95)
  expect(frames[0]!.cursor).toBe(2)
  expect(await service.activateDesktop('hidden')).toBe(false)
  expect(activateDesktop).not.toHaveBeenCalled()
  expect(await service.activateDesktop('visible')).toBe(true)
  expect(activateDesktop).toHaveBeenCalledTimes(1)
 }finally{await plugin.dispose();await plugin.await()}
})

it('does not let a non-owner caller publish or consume local Windows notifications',async()=>{
 const ctx=new Context(), show=vi.fn(async()=>true), close=vi.fn(async()=>{}), acknowledge=vi.fn(), events=vi.fn(async function*(){yield {supported:true}})
 const readers={activateDesktop:async()=>true,readSettings:()=>({desktop:true,volume:80,completed:{enabled:true,sound:'none' as const},interrupted:{enabled:true,sound:'none' as const},question:{enabled:true,sound:'none' as const},approval:{enabled:true,sound:'none' as const}}),allowsSession:()=>true,observe:async function*(){},desktop:{show,close,acknowledge,events}}
 const plugin=ctx.plugin(Notifications,readers);await plugin
 try{const service=ctx.get('dshNotifications') as Notifications;Object.defineProperty(service.ctx,'invocation',{configurable:true,value:{peer:{principal:{kind:'remote-visitor'}}}})
 expect(await service.showDesktop({owner:'owner',id:'id',title:'T',body:'B'})).toBe(false);await service.closeDesktop('owner','id');service.acknowledgeDesktop('owner','id');const frames=[];for await(const frame of service.desktopEvents('owner',new AbortController().signal))frames.push(frame);expect(frames).toEqual([{supported:false}]);expect(show).not.toHaveBeenCalled();expect(close).not.toHaveBeenCalled();expect(acknowledge).not.toHaveBeenCalled();expect(events).not.toHaveBeenCalled()
 }finally{await plugin.dispose();await ctx.fiber.dispose()}
})
