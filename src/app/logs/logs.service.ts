import { Injectable } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { combineLatest, Observable, of, throwError } from 'rxjs';
import { catchError, delay, map, switchMap } from 'rxjs/operators';

import { LogSummary } from 'src/app/logs/log-summary';
import { SpellId } from 'src/app/logs/spell-id.enum';

@Injectable()
export class LogsService {
  private static API_KEY = '259b121232ec91e17f4d2b48300801be';
  private static API_URL = 'https://classic.warcraftlogs.com/v1';

  private static MAX_EVENT_REQUESTS = 10; // 300 events per request * 10 = 3000 total

  private static TRACKED_ABILITIES = [
    SpellId.DEATH,
    SpellId.FADE,
    SpellId.FEAR_WARD,
    SpellId.MIND_BLAST,
    SpellId.MIND_FLAY,
    SpellId.PAIN,
    SpellId.SHADOW_FIEND,
    SpellId.SHIELD,
    SpellId.VAMPIRIC_EMBRACE,
    SpellId.VAMPIRIC_TOUCH
  ];

  private summaryCache: { [id: string]: LogSummary} = {};
  private eventCache: { [hash: string]: any} = {};

  constructor(private http: HttpClient) {}

  /**
   * Extract WCL report ID from a string,
   * expected to either be the ID (validated against regex...)
   * OR to be a WCL URL that can be parsed to find the ID
   * @param {string} value
   * @returns {string|null} report ID
   */
  extractLogId(value: string|null): string | null {
    let id: string | null = value || '';

    if (id.startsWith('http')) {
      const match = id.match(/warcraftlogs\.com\/reports\/([A-Za-z0-9]{16})/m);
      id = (match && match[1]) || null;
    } else if (!/^[A-Za-z0-9]{16}$/.test(id)) {
      id = null;
    }

    return id;
  }

  /**
   * Fetch summary data for a report
   * @param id Report ID
   * @returns {any}
   */
  getSummary(id: string) {
    if (this.summaryCache.hasOwnProperty(id)) {
      return of(this.summaryCache[id]);
    }

    const url = `${LogsService.API_URL}/report/fights/${id}`;
    return this.http.get<IEncountersResponse>(url, { params: this.makeParams() }).pipe(
      map((response) => {
        const summary = new LogSummary(id, response);
        this.summaryCache[id] = summary;
        return summary;
      }),
      catchError((response: HttpErrorResponse) => {
        return throwError(`Error fetching log: ${response.error.error}`);
      }),
    );
  }

  getEvents(log: LogSummary, playerName: string, encounterId: number) {
    const castsUrl = `${LogsService.API_URL}/report/events/casts/${log.id}`,
      damageUrl = `${LogsService.API_URL}/report/events/damage-done/${log.id}`;

    const encounter = log.getEncounter(encounterId);

    const params = {
      start: encounter!.start,
      end: encounter!.end,
      filter: `source.name="${playerName}" AND ability.id IN (${LogsService.TRACKED_ABILITIES.join(',')})`
    };

    return combineLatest([
      this.requestEvents(castsUrl, this.makeParams(params), []),
      this.requestEvents(damageUrl, this.makeParams(params), [])
    ]);
  }

  private makeParams(params: any = {}) {
    return Object.assign(params, { api_key: LogsService.API_KEY });
  }

  /**
   * Recursively fetch event data while more exists, up to MAX_EVENT_REQUESTS
   * @param url
   * @param params
   * @param events
   * @param depth
   * @private
   */
  private requestEvents(url: string, params: any, events: IEventData[], depth = 1): Observable<IEventData[]> {
    return this.http.get<IEventsResponse>(url, { params }).pipe(
      delay(200),
      switchMap((response) => {
        const newEvents = events.concat(response.events);

        if (response.nextPageTimestamp && response.nextPageTimestamp < params.end && depth < LogsService.MAX_EVENT_REQUESTS) {
          const newParams = Object.assign({}, params)
          newParams.start = response.nextPageTimestamp;

          return this.requestEvents(url, newParams, newEvents, depth + 1);
        } else {
          // todo -- caching
          return of(newEvents);
        }
      })
    );
  }
}

export interface IEncountersResponse {
  friendlies: IPlayerData[];
  fights: IEncounterData[];
}

export interface IEncounterData {
  id: number;
  name: string;
  start_time: number;
  end_time: number;
  boss: number;
  originalBoss: number;
  kill?: boolean;
}

export interface IPlayerData {
  id: number;
  name: string;
  type: string;
  icon: string;
}

export interface IEventsResponse {
  events: IEventData[];
  count: number;
  nextPageTimestamp?: number;
}

export interface IEventData {
  ability: { guid: SpellId; };
}