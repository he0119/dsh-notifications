// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
const worker=vi.hoisted(()=>({available:true,show:vi.fn(),close:vi.fn(),dispose:vi.fn(),activate:undefined as undefined|((id:string)=>void|Promise<void>)}))
vi.mock('../src/client/logic/service-worker-client.ts',()=>({createServiceWorkerNotifications:(activate:typeof worker.activate)=>{worker.activate=activate;return{supported:()=>worker.available,show:worker.show,close:worker.close,dispose:worker.dispose}}}))
import {createNotificationDelivery} from '../src/client/logic/delivery.ts'
const preferences={popupMode:'unfocused' as const,soundEnabled:false,volume:0,completed:{enabled:true,sound:'none' as const},interrupted:{enabled:true,sound:'none' as const},question:{enabled:true,sound:'none' as const},approval:{enabled:true,sound:'none' as const}}
const copy={title:()=> 'Done',body:()=> 'Finished',testTitle:'Test',testBody:'Test body'}
beforeEach(()=>{worker.available=true;worker.show.mockResolvedValue(true);worker.close.mockResolvedValue(undefined);vi.stubGlobal('isSecureContext',true);vi.spyOn(window,'focus').mockImplementation(()=>{});const native=Object.assign(vi.fn(function(){throw new TypeError('Illegal constructor')}),{permission:'granted',requestPermission:vi.fn()});vi.stubGlobal('Notification',native)})
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.clearAllMocks()})
it('submits Android notifications without calling its unsupported constructor and routes worker activation',async()=>{
 const open=vi.fn();const client=createNotificationDelivery(()=>preferences,open,copy,()=> 'root-1');try{const sent=client.test('none',0);await vi.waitFor(()=>expect(worker.show).toHaveBeenCalledOnce());await sent;expect(client.state.getSnapshot().testStatus).toBe('submitted');expect(client.state.getSnapshot().supported).toBe(true);expect(Notification).not.toHaveBeenCalled();await worker.activate?.('root-1');expect(open).toHaveBeenCalledWith('root-1');const id=worker.show.mock.calls[0]![0].id;client.dismiss(id);expect(worker.close).toHaveBeenCalledWith(id)}finally{await client.dispose();expect(worker.dispose).toHaveBeenCalledOnce()}
})
it('rechecks a hidden tab before submitting after worker initialization',async()=>{
 const focus=vi.spyOn(document,'hasFocus').mockReturnValue(false);vi.spyOn(document,'visibilityState','get').mockReturnValue('visible');const ready=Promise.withResolvers<void>();worker.show.mockImplementation(async(_request,eligible)=>{await ready.promise;return eligible()});const client=createNotificationDelivery(()=>preferences,vi.fn(),copy);try{const result=client.deliver({id:'root-finished',sessionId:'root-1',kind:'completed'});await vi.waitFor(()=>expect(worker.show).toHaveBeenCalledOnce());focus.mockReturnValue(true);ready.resolve();await result;expect(client.state.getSnapshot().failed).toBe(false);expect(Notification).not.toHaveBeenCalled()}finally{ready.resolve();await client.dispose()}
})
