/** Native notification preferences remain independently configurable after serialization. */
import Schema from '@deepseek-ai/schemastery'
import { resolveConfig } from '@deepseek-ai/cordis'
import { expect,it } from 'vitest'
import { Config, readNotificationsConfig } from '../src/config.ts'
it('has distinct default sounds and independently saves each notification category',()=>{
 const read=readNotificationsConfig
 const defaults=read(resolveConfig({Config},{}))
 expect(defaults).toEqual({desktop:true,popupMode:'unfocused',volume:80,soundEnabled:true,completed:{enabled:true,sound:'chime'},interrupted:{enabled:true,sound:'alert'},question:{enabled:true,sound:'soft'},approval:{enabled:true,sound:'double'}})
 const settings=read(resolveConfig({Config},{desktop:false,volume:95,question:{sound:'alert'},approval:{enabled:false,sound:'none'}}))
 expect(settings.question).toEqual({enabled:true,sound:'alert'})
 expect(settings.approval).toEqual({enabled:false,sound:'none'})
 expect(settings.completed).toEqual(defaults.completed)
 expect(settings.desktop).toBe(false)
 expect(settings.popupMode).toBe('never')
 expect(settings.soundEnabled).toBe(true)
 expect(read(resolveConfig({Config},{desktop:false,popupMode:'always'})).popupMode).toBe('always')
 const noSound=read(resolveConfig({Config},{soundEnabled:false,popupMode:'always'}))
 expect(noSound.soundEnabled).toBe(false)
 expect(noSound.popupMode).toBe('always')
 expect(()=>resolveConfig({Config},{popupMode:'sometimes'})).toThrow()
 expect(settings.volume).toBe(95)
 expect(()=>resolveConfig({Config},{volume:101})).toThrow()
 expect(()=>resolveConfig({Config},{volume:-1})).toThrow()
 expect(read(resolveConfig({Config},{approval:{sound:'custom'}})).approval.sound).toBe('custom')
 expect(()=>resolveConfig({Config},{completed:{sound:'arbitrary-file'}})).toThrow()
 const twice=new Schema(JSON.parse(JSON.stringify(new Schema(JSON.parse(JSON.stringify(Config))))))
 expect(()=>twice({question:{sound:'double'}})).not.toThrow()
})
