/** Native settings snapshots can omit fields introduced after their last save. */
import type {NotificationPopupMode,NotificationRule,NotificationSettings} from '../../runtime/types.ts'
import {DEFAULT_RULES,DEFAULT_SOUND_ENABLED,DEFAULT_USER_TURNS,DEFAULT_VOLUME,defaultPopupMode} from '../../defaults.ts'
interface NotificationPreferencesInput {desktop?:boolean;popupMode?:NotificationPopupMode;volume?:number;soundEnabled?:boolean;userTurns?:boolean;goalRounds?:boolean;subagentWake?:boolean;backgroundWake?:boolean;teamWake?:boolean;webhookWake?:boolean;pluginWake?:boolean;otherWake?:boolean;completed?:Partial<NotificationRule>;interrupted?:Partial<NotificationRule>;question?:Partial<NotificationRule>;approval?:Partial<NotificationRule>}
/** Fill new defaults without enabling notifications while their accepted source is unavailable. */
export function normalizeNotificationPreferences(value:NotificationPreferencesInput|undefined):NotificationSettings|undefined {
 if(value===undefined)return undefined
 const rule=(input:Partial<NotificationRule>|undefined,sound:NotificationRule['sound']):NotificationRule=>({enabled:input?.enabled??true,sound:input?.sound??sound})
 return {desktop:value.desktop??true,popupMode:value.popupMode??defaultPopupMode(value.desktop!==false),volume:value.volume??DEFAULT_VOLUME,soundEnabled:value.soundEnabled??DEFAULT_SOUND_ENABLED,userTurns:value.userTurns??DEFAULT_USER_TURNS,goalRounds:value.goalRounds??false,subagentWake:value.subagentWake??false,backgroundWake:value.backgroundWake??false,teamWake:value.teamWake??false,webhookWake:value.webhookWake??false,pluginWake:value.pluginWake??false,otherWake:value.otherWake??false,completed:rule(value.completed,DEFAULT_RULES.completed.sound),interrupted:rule(value.interrupted,DEFAULT_RULES.interrupted.sound),question:rule(value.question,DEFAULT_RULES.question.sound),approval:rule(value.approval,DEFAULT_RULES.approval.sound)}
}
