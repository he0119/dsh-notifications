/** Native settings snapshots can omit fields introduced after their last save. */
import type {NotificationPopupMode,NotificationRule,NotificationSettings} from '../../runtime/types.ts'
interface NotificationPreferencesInput {desktop?:boolean;popupMode?:NotificationPopupMode;volume?:number;soundEnabled?:boolean;completed?:Partial<NotificationRule>;interrupted?:Partial<NotificationRule>;question?:Partial<NotificationRule>;approval?:Partial<NotificationRule>}
/** Fill new defaults without enabling notifications while their accepted source is unavailable. */
export function normalizeNotificationPreferences(value:NotificationPreferencesInput|undefined):NotificationSettings|undefined {
 if(value===undefined)return undefined
 const rule=(input:Partial<NotificationRule>|undefined,sound:NotificationRule['sound']):NotificationRule=>({enabled:input?.enabled??true,sound:input?.sound??sound})
 return {desktop:value.desktop??true,popupMode:value.popupMode??(value.desktop===false?'never':'unfocused'),volume:value.volume??80,soundEnabled:value.soundEnabled??true,completed:rule(value.completed,'chime'),interrupted:rule(value.interrupted,'alert'),question:rule(value.question,'soft'),approval:rule(value.approval,'double')}
}
