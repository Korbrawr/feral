import { ActorStats } from 'src/app/logs/models/actor-stats';
import { Buff, BuffTrigger, IBuffDetails, IBuffEvent } from 'src/app/logs/models/buff-data';
import { Report } from 'src/app/report/models/report';
import { CastDetails } from 'src/app/report/models/cast-details';
import { DamageType, ISpellData, Spell } from 'src/app/logs/models/spell-data';
import { DamageInstance } from 'src/app/report/models/damage-instance';
import { HasteUtils, IHasteStats } from 'src/app/report/models/haste';
import { HitType } from 'src/app/logs/models/hit-type.enum';
import { IBuffData, ICastData, IDamageData, IEventData } from 'src/app/logs/interfaces';
import { IDeathLookup } from 'src/app/logs/logs.service';
import { LogSummary } from 'src/app/logs/models/log-summary';
import { mapSpellId, SpellId } from 'src/app/logs/models/spell-id.enum';
import { matchTarget } from 'src/app/report/analysis/utils';
import { PlayerAnalysis } from 'src/app/report/models/player-analysis';
import { AuraId } from 'src/app/logs/models/aura-id.enum';
import { ResourceType } from 'src/app/logs/models/resource-type.enum';
import { duration } from '../models/stat-utils';

export class EventAnalyzer {
  public static DIRECT_EVENT_LEEWAY = 150; // in milliseconds. Allow damage to occur just slightly later than "should" be
  public static EVENT_LEEWAY = 100; // in milliseconds. Allow damage to occur just slightly later than "should" be
  // possible given strict debuff times. Blah blah server doesn't keep time exactly.

  public static TRAVEL_TIME_LEEWAY = 2500;

  private static MIN_INFER_HASTE_EVENTS = 8; // require a minimum of MB/VT casts to infer missing haste value

  private analysis: PlayerAnalysis;

  private baseStats: ActorStats;
  private buffData: IBuffData[];
  private castData: ICastData[];
  private damageData: IDamageData[];
  private deaths: IDeathLookup;
  private damageBySpell: { [spellId: number]: IDamageData[] };
  private events: IEventData[];

  // tracks currently active buffs
  private buffs: IBuffEvent[] = [];

  constructor(analysis: PlayerAnalysis) {
    this.analysis = analysis;
    this.baseStats = Object.assign({}, analysis.actorInfo.stats) as ActorStats;

    // initialize event data
    this.buffData = analysis.events.buffs;
    this.castData = analysis.events.casts;
    this.damageData = analysis.events.damage;
    this.deaths = analysis.events.deaths;

    // partition damage events by spell ID for association with casts
    this.initializeDamageBuckets();

    // Merge buff and cast data into a single array to process
    this.events = this.mergeEvents();

    // if haste info is missing from combatant info, and not specified in settings, then try to infer it...
    if (typeof this.baseStats?.hasteRating === 'undefined') {
      this.inferBaseHaste();
    }
  }

  /**
   * Compile WCL events into Casts suitable for analysis
   * @param {LogSummary} log
   * @param {ICastData[]} castData
   * @param {IDamageData[]} damageData
   * @returns {Report}
   */
  public createCasts(): CastDetails[] {
    let event: IEventData,
      currentCast: ICastData,
      castBuffs: IBuffEvent[] = [],
      activeStats: IHasteStats | null = null,
      startingCast: ICastData | null = null,
      lastEnergy: number | null = null,
      lastEnergyTimestamp: number | null = null;

    const casts: CastDetails[] = [];


    while (this.events.length > 0) {
      event = this.events.shift() as IEventData;

      let eventEnergy: number | undefined = undefined;

      // Check for energy
      const energy = event.classResources?.find(x => x.type === ResourceType.ENERGY);
      if (energy) {
        eventEnergy = energy.amount;
        const energyCost =
          Spell.energyCost(event.ability.guid,
            this.buffs.some(x => x.id == AuraId.FERAL_BERSERK),
            this.buffs.some(x => x.id == AuraId.OOC_CLEARCASTING)
          );
        lastEnergy = eventEnergy - energyCost;
        if (lastEnergy < 0) {
          if (event.ability.guid != SpellId.BITE) {
            const tsFormatted = (event.timestamp - this.analysis.encounter.start) / 1000;
            console.log(`${tsFormatted} Negative Energy Encountered ${lastEnergy} cost ${energyCost}`);
            console.log(event);
            console.log(this.buffs.slice());
          }
          lastEnergy = 0;
        }
        lastEnergyTimestamp = event.timestamp;
      }
      else if (lastEnergyTimestamp !== null && lastEnergy !== null) {
        const delta = event.timestamp - lastEnergyTimestamp;
        const gainedEnergy = delta / 100;
        eventEnergy = lastEnergy + gainedEnergy;
        eventEnergy = Math.min(eventEnergy, 100);
      }

      switch (event.type) {
        case 'applybuff':
        case 'refreshbuff':
        case 'applydebuff':
        case 'refreshdebuff':
          this.applyBuff(event as IBuffData, Buff.get(event.ability, this.analysis.settings));
          continue;

        case 'removebuff':
        case 'removedebuff':
          this.removeBuff(event as IBuffData);
          continue;

        case 'begincast':
          startingCast = event as ICastData;
          activeStats = HasteUtils.calc(this.baseStats, this.buffs);
          castBuffs = this.buffs.slice();
          continue;
      }

      // after fall-through we are processing only a cast and no other event type
      currentCast = event as ICastData;
      const castId = mapSpellId(currentCast.ability.guid);
      const baseSpellData = Spell.dataBySpellId[castId];

      // if the completed cast isn't the one we started, remove starting info
      // note that starting cast events don't have the target info but we shouldn't need to match it
      // because if we switch targets we'll have a new begincast event anyway
      if (startingCast && currentCast.ability.guid !== startingCast.ability.guid) {
        startingCast = null;
        activeStats = null;
        castBuffs = [];
      }

      // Evaluate stats for cast
      // - For direct spells with a cast time, we care about haste at cast start
      // - But for hasted dots, it's status at cast completion that determine tick intervals,
      //   even though stats at cast start determined the cast time
      //
      // We care more about the tick intervals than the cast time, so for this case
      // we should track the stats at cast end
      if (!activeStats || baseSpellData.dotHaste) {
        activeStats = HasteUtils.calc(this.baseStats, this.buffs);
        castBuffs = this.buffs.slice();
      }


      const spellData = Spell.get(castId, this.analysis.settings, activeStats.totalHaste - 1, this.analysis.tierBonuses);

      const details = new CastDetails({
        castId,
        spellId: spellData.mainId,
        rank: Spell.rank(castId, spellData),
        downranked: castId !== spellData.mainId,
        ability: currentCast.ability,
        sourceId: currentCast.sourceID,
        targetId: currentCast.targetID,
        targetInstance: currentCast.targetInstance,
        castStart: startingCast?.timestamp || currentCast.timestamp,
        castEnd: currentCast.timestamp,
        buffs: castBuffs.map((b) => b.data),
        spellPower: currentCast.attackPower,
        haste: activeStats!.totalHaste - 1,
        gcd: spellData.gcd ? activeStats!.gcd : 0,
        classResources: currentCast.classResources,
        energy: eventEnergy !== undefined ? eventEnergy as number : undefined,
      });


      casts.push(details);

      if (spellData.damageType !== DamageType.NONE) {
        if (spellData.damageType === DamageType.DIRECT) {
          this.setDamage(details, spellData);
        } else {
          this.setMultiInstanceDamage(details);

          // check for lost ticks to enemy death
          this.setTruncationByDeath(details, spellData);
        }
      }


      startingCast = activeStats = null;
    }

    return casts;
  }

  // strategy -- infer a gear haste rating by evaluating all MB/VT casts with buffs accounted for
  // Need to average across casts to smooth out the effects of variance in server processing time
  // This isn't perfectly accurate, but it should be very close
  // (and this strategy is a fallback for when logs are missing data)
  private inferBaseHaste() {
    let startingCast: ICastData | undefined,
      cast: ICastData,
      spellData: ISpellData,
      event: IEventData,
      stats = HasteUtils.calc(this.baseStats, this.buffs);

    let hasteCount = 0, castCount = 0, totalHaste = 0;

    this.buffs = [];
    for (let i = 0; i < this.events.length; i++) {
      event = this.events[i];

      switch (event.type) {
        case 'applybuff':
        case 'refreshbuff':
          this.applyBuff(event as IBuffData, Buff.get(event.ability, this.analysis.settings));
          continue;

        case 'removebuff':
          this.removeBuff(event as IBuffData);
          continue;

        case 'begincast':
          startingCast = event as ICastData;
          stats = HasteUtils.calc(this.baseStats, this.buffs);
          continue;

        case 'cast':
          cast = event as ICastData;
          spellData = Spell.baseData(mapSpellId(event.ability.guid));
        // if ((cast.ability.guid === SpellId.VAMPIRIC_TOUCH || cast.ability.guid === SpellId.MIND_BLAST) &&
        //   cast.ability.guid === startingCast?.ability?.guid) {

        //   const castTime = (cast.timestamp - startingCast.timestamp) / 1000,
        //     baseCastTime = spellData.baseCastTime / stats.totalHaste;

        //   if (castTime <= baseCastTime) {
        //     const inferredRating = HasteUtils.inferRating(stats.totalHaste, spellData.baseCastTime, castTime);

        //     if (inferredRating > 0) {
        //       totalHaste += inferredRating;
        //       hasteCount++;
        //     }
        //   }

        //   castCount++;
        // }
      }
    }

    const hastedPercent = hasteCount / castCount,
      estimate = totalHaste / castCount;

    // In order to actually estimate this somewhat reasonably, we want
    // 1. A minimum number of casts evaluated
    // 2. of which at least 2/3 had evidence of "extra" unaccounted for haste.
    // 3. with an estimate of at least 8 haste rating, since no item has less haste than that at 70
    if (castCount > EventAnalyzer.MIN_INFER_HASTE_EVENTS && hastedPercent > 0.66 && estimate >= 8) {
      this.baseStats = ActorStats.inferred(estimate);
    }

    this.buffs = [];
  }

  // merge buff events into cast data in order, so we can just loop over the combined set to process
  private mergeEvents(): IEventData[] {
    if (!this.buffData || this.buffData.length === 0) {
      return [... this.castData];
    }

    const events: IEventData[] = [];
    let buffIndex = 0, nextBuff = this.buffData[buffIndex],
      castIndex = 0, lastCast: ICastData | undefined = undefined, nextCast = this.castData[castIndex];

    do {
      if (nextBuff && (!nextCast || this.buffHasPriority(nextBuff, nextCast, lastCast))) {
        events.push(nextBuff);
        nextBuff = this.buffData[++buffIndex];
      } else if (nextCast) {
        events.push(nextCast);
        lastCast = nextCast;
        nextCast = this.castData[++castIndex];
      }
    } while (nextBuff || nextCast);

    return events;
  }

  // should buff be applied before this cast?
  private buffHasPriority(buff: IBuffData, nextCast: ICastData, lastCast?: ICastData) {
    const data = Buff.data[buff.ability.guid];
    switch (data?.trigger) {
      case BuffTrigger.CAST_END:
        // if this buff was triggered by the end of the previous cast
        // and is happening at the same time as nextCast,
        // then the buff applies to this cast only if the last cast shares the same timestamp
        // because of spell queueing
        return (buff.timestamp < nextCast.timestamp) ||
          (buff.timestamp === nextCast.timestamp && lastCast?.timestamp === buff.timestamp);

      case BuffTrigger.ON_USE:
        // On use abilities are generally off-CD and can be started at the same timestamp as the cast
        return buff.timestamp <= nextCast.timestamp;

      default:
        // External buffs need to occur before the cast starts.
        return buff.timestamp < nextCast.timestamp;
    }
  }

  private initializeDamageBuckets() {
    this.damageBySpell = Object.keys(Spell.data)
      .reduce((lookup, spellId) => {
        lookup[parseInt(spellId)] = [];
        return lookup;
      }, {} as { [spellId: number]: IDamageData[] });

    for (const event of this.damageData) {
      const data = Spell.fromDamageId(mapSpellId(event.ability.guid));

      if (data && this.damageBySpell.hasOwnProperty(data.mainId)) {
        this.damageBySpell[data.mainId].push(event);
      }
    }
  }

  private applyBuff(event: IBuffData, data: IBuffDetails) {
    const existing = this.buffs.find((b) => b.id === event.ability.guid);
    if (existing) {
      existing.event = event;
    } else {
      this.buffs.push({ id: event.ability.guid, data, event });
    }
  }

  private removeBuff(event: IBuffData) {
    const index = this.buffs.findIndex((b) => b.id === event.ability.guid);
    if (index >= 0) {
      this.buffs.splice(index, 1);
    }
  }

  private setDamage(cast: CastDetails, spellData: ISpellData) {
    if (this.damageBySpell.hasOwnProperty(cast.spellId)) {
      const event = this.damageBySpell[cast.spellId].find((d) =>
        this.matchDamage(cast, spellData, d, cast.castEnd, true));

      if (event) {
        cast.targetId = event.targetID;
        cast.setInstances([new DamageInstance((event))]);
        event.read = true;
        return;
      }
    }
  }

  public showUnreadEvents() {
    for (const sId in this.damageBySpell) {
      if (parseInt(sId) == SpellId.MELEE)
        continue;
      const arr = this.damageBySpell[sId];
      arr.forEach(x => {
        if (!x.read) {
          console.log(
            duration(x.timestamp - this.analysis.encounter.start),
            x.ability.name, x);
        }
      });
    }
  }

  private setMultiInstanceDamage(cast: CastDetails) {
    const spellData = Spell.get(cast.spellId, this.analysis.settings, undefined, this.analysis.tierBonuses); // use base data for duration since haste can have errors
    let i = 0;
    let instances: DamageInstance[] = [];
    let instancesById: { [id: number]: number } = {};
    let nextCast: ICastData | null;
    let nextDamage: IDamageData | null;
    let maxDamageTimestamp = spellData.maxDuration > 0 ?
      cast.castEnd + (spellData.maxDuration * 1000) + (spellData.maxDamageInstances * EventAnalyzer.EVENT_LEEWAY) :
      this.analysis.encounter.end;

    const damageEvents = this.damageBySpell[cast.spellId] || [];

    if (cast.targetId && this.analysis.getActorName(cast.targetId) === undefined) {
      // cast on "Unknown Actor" in WCL. Try to infer the target first
      // look for a damage event around the time we should expect a hit for the spell
      // and infer the actual target from that instance, if found.
      const delta = spellData.maxDuration > 0 ? (spellData.maxDuration / spellData.maxDamageInstances) * 1000 : spellData.damageType === DamageType.DIRECTAOE ? 500 : 3000;
      const firstDamageTimestamp = cast.castEnd + delta + EventAnalyzer.EVENT_LEEWAY;
      const firstInstance = damageEvents.find((e) =>
        this.matchDamage(cast, spellData, e, firstDamageTimestamp, true));

      if (firstInstance) {
        cast.targetId = firstInstance.targetID;
      }
    }

    do {
      nextCast = this.events.length > i ? (this.events[i] as ICastData) : null;
      if (nextCast === null || this.castIsReplacement(cast, spellData, nextCast, damageEvents)) {
        if (nextCast) {
          maxDamageTimestamp = nextCast.timestamp;
        }
        break;
      }
      i++;
    } while (nextCast.timestamp <= maxDamageTimestamp + EventAnalyzer.EVENT_LEEWAY);



    // Process damage instances for this spell within the window
    nextDamage = damageEvents[0];
    let count = 0;
    i = 0;

    while (nextDamage && (!spellData.maxDamageInstances || count < spellData.maxDamageInstances)) {
      if (this.matchDamage(cast, spellData, nextDamage, maxDamageTimestamp)
        && (!spellData.hasInitialHit || count == 0 || nextDamage.tick == true)) {
        // Prevent initial dot hits(rake/lacerate) from being applied to the previous application

        // This is a little complicated because of differences between channeled, dot, and AoE damage
        // Each individual damage instance for AoE can resist individually, so we just count them all without condition
        //
        // But for a channel or dot, a full resist can only happen on the first instance, and means the cast resisted
        // We want to keep the damage instance for the full resist in that case, but only if it's the first instance.
        // Otherwise we can encounter a full resist in a string of dot damage instances and it just means some
        // *future* cast resisted, and we should ignore it for the cast currently processing.

        // Additionally, now this has to deal with mobs being immune to the DoT portion of DP but not the
        // direct damage part of Improved DP
        const damageId = mapSpellId(nextDamage.ability.guid);

        const maxForDamageId = spellData.maxInstancesPerDamageId ?
          spellData.maxInstancesPerDamageId[damageId] :
          spellData.maxDamageInstances;
        const countForDamageId = instancesById[damageId] || 0;
        const failed = this.failed(cast.spellId, nextDamage, countForDamageId);

        if ((!maxForDamageId || countForDamageId < maxForDamageId) &&
          (spellData.damageType === DamageType.AOE || spellData.damageType === DamageType.DIRECTAOE || countForDamageId === 0 || !failed)) {
          instances.push(new DamageInstance(nextDamage));

          if (instancesById.hasOwnProperty(damageId)) {
            instancesById[damageId]++;
          } else {
            instancesById[damageId] = 1;
          }

          nextDamage.read = true;
          count++;
        }
      }
      nextDamage = damageEvents[++i];
    }

    cast.setInstances(instances);
  }

  // if a channeled spell or DoT didn't get all ticks,
  // check to see if it was truncated by the target's death
  private setTruncationByDeath(cast: CastDetails, spellData: ISpellData) {
    const key = `${cast.targetId}:${cast.targetInstance}`;
    const targetDeathTimestamp = this.deaths[key] || this.analysis.encounter.end;
    const checkTruncation = [DamageType.CHANNEL, DamageType.DOT].includes(spellData.damageType);

    if (checkTruncation && cast.hits < spellData.maxTicks && targetDeathTimestamp) {
      const lastTick = cast.lastDamageTimestamp || cast.castEnd;
      const nextTickBy = lastTick + ((spellData.maxDuration / spellData.maxTicks) * 1000);

      if (targetDeathTimestamp < nextTickBy + EventAnalyzer.EVENT_LEEWAY) {
        cast.truncated = true;
      }
    }
  }

  // next replaces the current cast if ALL of these conditions are true
  // -- the cast completed (type is 'cast', not 'begincast')
  // -- on the same kind of mob (targetID)
  // -- on the same instance of that mob (e.g. in WCL "Spellbinder 3" is a different instance from "Spellbinder 2"
  // -- and the cast was not resisted (requires finding an associated damage instance)
  private castIsReplacement(cast: CastDetails, spellData: ISpellData, next: ICastData, events: IDamageData[]) {
    // check for matching target

    if (next.type !== 'cast' || Spell.baseData(next.ability.guid).mainId !== cast.spellId ||
      next.targetID !== cast.targetId || next.targetInstance !== cast.targetInstance || spellData.damageType == DamageType.DIRECTAOE) {
      return false;
    }

    // check for resist/immune
    const failed = events.find((e) =>
      this.failed(cast.spellId, e) && matchTarget(this.analysis, next, spellData, e) &&
      e.timestamp > next.timestamp - 50 && e.timestamp < next.timestamp + 50
    );
    if (failed) {
      return false;
    }

    return true;
  }

  private failed(spellId: SpellId, event: IDamageData, count?: number) {
    if ([HitType.RESIST, HitType.MISS, HitType.DODGE, HitType.PARRY].includes(event.hitType) ||
      ([HitType.BLOCK, HitType.CRIT_BLOCK].includes(event.hitType) && event.amount === 0)) {
      return true;
    }

    return false;
  }

  private matchDamage(cast: CastDetails,
    spellData: ISpellData,
    next: IDamageData,
    maxTimestamp: number,
    allowUnknown = false) {
    if (next.read || !matchTarget(this.analysis, cast, spellData, next, allowUnknown)) {
      return false;
    }


    // damage must take place in the proper window
    // for dots, allow EVENT_LEEWAY for each tick
    const leeway = (spellData.maxDamageInstances > 1 && spellData.damageType == DamageType.DOT) ?
      (spellData.maxDamageInstances * EventAnalyzer.EVENT_LEEWAY) :
      EventAnalyzer.DIRECT_EVENT_LEEWAY + (spellData.hasTravelTime ? EventAnalyzer.TRAVEL_TIME_LEEWAY : 0);


    if (next.timestamp < (cast.castEnd - EventAnalyzer.EVENT_LEEWAY) || next.timestamp > (maxTimestamp + leeway)) {
      return false;
    }

    return true;
  }
}
