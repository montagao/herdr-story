import type { ReplayMoment } from '../shared/replay';
import { replayMoney } from '../shared/replay';
import { Celebrate } from './celebrate';
import { Cutscenes, actorOf, awardsNight, launchDay } from './cutscenes';
import type { OfficeScene } from './scenes/OfficeScene';
import type { OfficeModel } from './model/office';
import type { AgentInfo, OfficeEvent } from '../shared/types';
import { projectName } from '../shared/studio';

/** Use the same windows as the connected office. The timeline waits for each presentation. */
export class ReplayPresentation {
  autoCamera = true;
  readonly pendingPayments = new Set<string>();
  onPaid?: () => void;
  private generation = 0;
  readonly party = new Celebrate();
  advance(delta: number) { this.party.advance(delta); this.scenes.advance(delta); }
  readonly scenes: Cutscenes;
  constructor(private office: () => OfficeScene | undefined, private model: OfficeModel) {
    this.party.replay = true;
    this.party.entryOf = id => model.studio?.journal.find(e => e.id === id);
    this.scenes = new Cutscenes(() => office()?.textures);
    this.scenes.replay = true;
  }
  get busy() { return this.pendingPayments.size > 0 || this.party.isOpen || this.scenes.pending; }
  reset() { this.generation++; this.pendingPayments.clear(); this.office()?.cancelReplayCustomer(); this.party.close(); this.scenes.reset(); document.body.classList.remove('replay-arrival'); }
  show(moment: ReplayMoment, preview = false) {
    const office = this.office();
    if (moment.kind === 'studio') return;
    if (moment.kind === 'agent') {
      if (this.autoCamera && (moment.agent?.wait_notice || moment.agent?.agent_status === 'blocked')) office?.frameReplay(moment.pane);
      return;
    }
    if (moment.kind === 'event') { office?.react(moment.event, 0); return; }
    const entry = moment.entry;
    const money = moment.kind === 'money' ? moment.event : replayMoney(moment.entry);
    if (money) {
      if (this.autoCamera) office?.frameReplay();
      const arrival = !preview && office && money.amount > 0 && ['sale', 'subscribed', 'subscription_started'].includes(money.kind);
      if (arrival) {
        const generation = this.generation;
        this.pendingPayments.add(moment.id); document.body.classList.add('replay-arrival');
        void office.replayPayment(money, () => {
          if (generation !== this.generation) return;
          this.pendingPayments.delete(moment.id); document.body.classList.remove('replay-arrival');
          this.party.money(money, money.label); this.onPaid?.();
        });
      } else {
        office?.money(money, { immediate: true });
        this.party.money(money, money.label);
      }
      // Non-payment billing events have no payday window in the live office either.
      return;
    }
    if (!entry) return;
    const employee = this.model.studio?.employees.find(e => entry.contributors.includes(e.id));
    const agent = [...this.model.agents.values()].find(a => a.employee_id && entry.contributors.includes(a.employee_id));
    const actor: AgentInfo | undefined = agent ?? (employee ? { pane_id:`replay:${employee.id}`, agent:employee.kind,
      office_name:employee.name, office_look:{body:employee.body,face:employee.face}, agent_status:'done' } : undefined);
    if (this.autoCamera && actor) office?.frameReplay(actor.pane_id);
    if (entry.kind === 'task' && actor) {
      const event: OfficeEvent = { id:moment.id, ts:entry.at, kind:'status', pane_id:actor.pane_id, agent:actor.agent ?? 'agent',
        status:'done', title:entry.title, prev:'working', prev_for_ms:(entry.minutes ?? 0) * 60000,
        completion:{employeeId:employee?.id ?? actor.employee_id ?? entry.contributors[0],total:employee?.shipped ?? 0,stat:entry.stat ?? 'program',entryId:entry.id} };
      office?.react(event, 0, entry.stat);
      this.party.show(actor, event, entry.stat);
    } else if (entry.kind === 'milestone' && actor) {
      this.scenes.play(awardsNight(actorOf(actor), entry.title, `Trophy for ${projectName(entry.project)}`));
    } else if (entry.kind === 'release') {
      this.scenes.play(launchDay(`${projectName(entry.project)} is out`, entry.title, entry.notes));
    }
  }
}
