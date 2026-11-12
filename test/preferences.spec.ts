import {expect,it} from 'vitest'
import {normalizeNotificationPreferences} from '../src/client/logic/preferences.ts'
it('upgrades legacy native form values that omit newer audio fields',()=>{
 const value=normalizeNotificationPreferences({desktop:false,completed:{enabled:false}})!
 expect(value.volume).toBe(80);expect(value.soundEnabled).toBe(true);expect(value.popupMode).toBe('never')
 expect(value.completed).toEqual({enabled:false,sound:'chime'});expect(value.approval).toEqual({enabled:true,sound:'double'})
})
it('preserves explicit zero, mute and popup mode independently',()=>{
 const value=normalizeNotificationPreferences({desktop:false,volume:0,soundEnabled:false,popupMode:'always'})!
 expect(value.volume).toBe(0);expect(value.soundEnabled).toBe(false);expect(value.popupMode).toBe('always')
})
it('does not invent accepted preferences before the native form or stream is ready',()=>expect(normalizeNotificationPreferences(undefined)).toBeUndefined())
