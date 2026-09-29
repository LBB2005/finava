import { join } from "node:path";
import type { ExchangeCalendar } from "../marketCalendar";
import type { TournamentRow } from "./types";
import type { DayMark } from "./portfolio";
import { DatedSources } from "./sources";
import { ProviderArchive } from "./providerArchive";
import { LiveMarkets } from "./liveMarkets";
import { LiveSnapshots } from "./liveSnapshots";

/** Explicit archives retain priority; otherwise collect through existing keys. */
export function createTournamentSources(
  calendar: Pick<ExchangeCalendar,"range">,
  collectionDate: string,
  env: Readonly<Record<string,string|undefined>> = process.env,
  requester?: (url:string)=>Promise<unknown>,
) {
  if(env.TOURNAMENT_DATA_DIR || env.TOURNAMENT_DATA_URL)
    return new DatedSources({directory:env.TOURNAMENT_DATA_DIR,url:env.TOURNAMENT_DATA_URL});
  const archive=new ProviderArchive({
    directory:join(env.TOURNAMENT_RAW_DIR ?? ".tournament/provider-cache",collectionDate),
    key:env.ALPACA_API_KEY,secret:env.ALPACA_API_SECRET,massiveKey:env.POLYGON_API_KEY,
  });
  const get=requester ?? archive.get.bind(archive);
  const markets=new LiveMarkets({get,calendar});
  const snapshots=new LiveSnapshots({get,calendar,market:markets,
    onProgress:(done,total)=>console.log(`Dated evidence: ${done}/${total} names collected`)});
  return {
    snapshot:(date:string)=>snapshots.collect(date),
    returns:(row:TournamentRow)=>markets.returns(row),
    async mark(ticker:string,date:string):Promise<DayMark> {
      try { return await markets.mark(ticker,date); }
      catch(error) {
        return {open:null,close:null,splitFactor:null,cashPerPreviousShare:null,actionsComplete:false,
          reason:error instanceof Error?error.message:"Market evidence unavailable"};
      }
    },
  };
}
