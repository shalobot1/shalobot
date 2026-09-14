//+------------------------------------------------------------------+
//|                                               ShalobotMT5.mq5   |
//|   Shalobot — Headway MT5 automation (custody-free)             |
//|                                                                   |
//|   The AI/strategy runs in Shalobot's cloud. This EA polls the signal  |
//|   feed and executes on YOUR terminal, on YOUR account — Shalobot      |
//|   never sees a password. Put it on a VPS (MT5 Virtual Hosting)    |
//|   to trade 24/7 with your PC off.                                 |
//|                                                                   |
//|   Opens trades, sets stop-loss & take-profit, TRAILS the stop,    |
//|   banks PARTIAL profits, PYRAMIDS into strong trends, and caps    |
//|   total + per-correlation open risk — all sized to your balance.  |
//|                                                                   |
//|   One-time setup: Tools > Options > Expert Advisors >             |
//|     tick "Allow WebRequest for listed URL" and add:               |
//|         https://www.shalobot.com                               |
//+------------------------------------------------------------------+
#property copyright "Shalobot"
#property link      "https://www.shalobot.com"
#property version   "3.10"
#property strict

#include <Trade/Trade.mqh>

enum RiskProfile { CONSERVATIVE=0, MODERATE=1, AGGRESSIVE=2 };

input RiskProfile InpProfile        = AGGRESSIVE; // Risk profile — Conservative / Moderate / Aggressive (sets the risk caps)
input int         InpPollSeconds    = 30;         // How often to poll for signals
input long        InpMagic          = 88090077;   // Magic number (Shalobot trades only)
input int         InpMaxSpreadPts   = 40;         // Skip if spread exceeds this (points)
input string      InpSymbolSuffix   = "";         // Broker symbol suffix, e.g. ".r" (blank if none)
input double      InpMaxDailyLossPct= 5;          // Daily-loss cap % of day-start equity (halts new entries)
input int         InpReentryCooldownMin = 15;     // Min minutes before re-entering the same symbol
input int         InpMinStopPoints  = 10;         // Reject signals whose stop is closer than this (points)
input bool        InpEnableTrailing = true;       // Trail the stop as price advances
input bool        InpEnablePartials = true;       // Bank partial profits at the ladder
input bool        InpEnablePyramid  = true;       // Add to winners (needs a hedging account)
input bool        InpTradingEnabled = true;       // Master on/off switch

// One parsed signal line from the feed.
struct Sig
  {
   string sym, side, clu;
   double entry, sl, tp, risk, trail;
   int    nP; double pPrice[8]; double pPct[8];
   int    nA; double aPrice[8]; double aPct[8];
  };

string  g_base = "https://www.shalobot.com/api/mt5/signals";
CTrade  g_trade;
double  g_dayStartEquity = 0.0;
int     g_dayStart = 0;
double  g_maxOpenRisk = 0.0;   // from the feed "# caps:" header
double  g_corrCap     = 0.0;
double  g_dailyLoss   = 0.0;   // per-profile daily-loss cap % (from the feed)
long    g_feedTs      = 0;     // feed generation time (unix, from "ts=")

//+------------------------------------------------------------------+
int OnInit()
  {
   g_trade.SetExpertMagicNumber(InpMagic);
   g_trade.SetDeviationInPoints(20);
   // Restore last-known risk caps (account-scoped) so a header-less first poll
   // still has limits; a fresh account with none blocks entries until caps arrive.
   g_maxOpenRisk = GVget("ev_capmax"+AcctSuffix(), 0);
   g_corrCap     = GVget("ev_capcorr"+AcctSuffix(), 0);
   g_dailyLoss   = GVget("ev_capdaily"+AcctSuffix(), 0);
   // Persist the daily-loss baseline PER ACCOUNT so a mid-day reinit/restart (or a
   // demo<->real account switch in the same terminal) doesn't re-anchor it.
   int today = DayOfYearNow();
   if(GlobalVariableCheck("ev_daykey"+AcctSuffix()) && (int)GVget("ev_daykey"+AcctSuffix(),0)==today)
      g_dayStartEquity = GVget("ev_dayeq"+AcctSuffix(), AccountInfoDouble(ACCOUNT_EQUITY));
   else
      SetDayBaseline(today);
   g_dayStart = today;

   EventSetTimer(MathMax(5, InpPollSeconds));
   PrintFormat("Shalobot EA v3.1 started — profile=%s, trading forex, metals and crypto. Ensure https://www.shalobot.com is whitelisted in WebRequest.", ProfileStr());
   Poll();
   return(INIT_SUCCEEDED);
  }

void OnDeinit(const int reason) { EventKillTimer(); }
void OnTimer() { Poll(); }

//+------------------------------------------------------------------+
//| Strategy-Tester optimization criterion (for "Custom max").       |
//|                                                                   |
//| IMPORTANT: this EA trades a LIVE cloud signal feed over           |
//| WebRequest, and MQL5 DISABLES WebRequest inside the Strategy      |
//| Tester — so a backtest/optimization gets NO signals and places    |
//| no trades. Test it by attaching it to a chart on a DEMO account   |
//| in REAL TIME (not the tester). This function only exists so the   |
//| tester's "Custom max" mode doesn't error out.                     |
//+------------------------------------------------------------------+
double OnTester()
  {
   double profit = TesterStatistics(STAT_PROFIT);
   double ddPct  = TesterStatistics(STAT_EQUITY_DDREL_PERCENT);
   double trades = TesterStatistics(STAT_TRADES);
   if(trades < 1) return 0.0;
   return profit / (1.0 + ddPct);   // reward profit, penalise drawdown
  }

// Stamp the re-entry cooldown when an Shalobot position CLOSES (not at entry).
void OnTradeTransaction(const MqlTradeTransaction &trans, const MqlTradeRequest &req, const MqlTradeResult &res)
  {
   if(trans.type!=TRADE_TRANSACTION_DEAL_ADD) return;
   if(trans.deal==0 || !HistoryDealSelect(trans.deal)) return;
   if(HistoryDealGetInteger(trans.deal, DEAL_MAGIC)!=InpMagic) return;
   if(HistoryDealGetInteger(trans.deal, DEAL_ENTRY)!=DEAL_ENTRY_OUT) return;
   StampCooldown(HistoryDealGetString(trans.deal, DEAL_SYMBOL));
  }

//+------------------------------------------------------------------+
string ProfileStr()
  {
   if(InpProfile==CONSERVATIVE) return "conservative";
   if(InpProfile==AGGRESSIVE)   return "aggressive";
   return "moderate";
  }
int DayOfYearNow() { MqlDateTime t; TimeToStruct(TimeCurrent(), t); return t.day_of_year; }

double GVget(string k, double def) { return GlobalVariableCheck(k) ? GlobalVariableGet(k) : def; }
void   GVset(string k, double v)   { GlobalVariableSet(k, v); }
// MT5 GlobalVariables are terminal-wide (shared across accounts); scope the
// per-account state (daily baseline, cached caps) by login so a demo<->real
// switch can't restore a foreign anchor.
string AcctSuffix() { return "_"+(string)AccountInfoInteger(ACCOUNT_LOGIN); }
void   SetDayBaseline(int day)
  { g_dayStartEquity=AccountInfoDouble(ACCOUNT_EQUITY); GVset("ev_daykey"+AcctSuffix(),day); GVset("ev_dayeq"+AcctSuffix(),g_dayStartEquity); }

// Numeric id for a correlation cluster string (for per-cluster risk summing via GVs).
double ClusterId(string s)
  { long h=0; for(int i=0;i<StringLen(s);i++) h=h*31+(long)StringGetCharacter(s,i); return (double)h; }

//+------------------------------------------------------------------+
//| Main loop                                                        |
//+------------------------------------------------------------------+
void Poll()
  {
   if(!InpTradingEnabled) return;

   if(DayOfYearNow()!=g_dayStart) { g_dayStart=DayOfYearNow(); SetDayBaseline(g_dayStart); }

   // Daily-loss cap = the profile's cap (from the feed), or the manual input;
   // when both are set the TIGHTER one wins (a user can only ever be safer).
   double dailyCap = InpMaxDailyLossPct;
   if(g_dailyLoss>0) dailyCap = (dailyCap>0) ? MathMin(dailyCap, g_dailyLoss) : g_dailyLoss;
   bool dailyHalt=false;
   if(dailyCap>0 && g_dayStartEquity>0)
     {
      double dd=(AccountInfoDouble(ACCOUNT_EQUITY)-g_dayStartEquity)/g_dayStartEquity*100.0;
      if(dd <= -dailyCap) dailyHalt=true;   // block NEW entries; still manage open trades
     }

   // One self-contained EA: trades every live market (forex, metals, crypto)
   // sized to the chosen risk profile. No Bot ID / pairing needed.
   string url = StringFormat("%s?profile=%s&categories=forex,metals,crypto&format=csv", g_base, ProfileStr());
   string body = HttpGet(url);

   Sig sigs[]; int nSigs=0;
   if(body!="")
     {
      string lines[]; int n=StringSplit(body, '\n', lines);
      ArrayResize(sigs, n);
      for(int i=0;i<n;i++)
        {
         string ln=lines[i]; StringTrimLeft(ln); StringTrimRight(ln);
         if(StringLen(ln)==0) continue;
         if(StringGetCharacter(ln,0)=='#') { ParseCaps(ln); continue; }
         if(ParseLine(ln, sigs[nSigs])) nSigs++;
        }
      ArrayResize(sigs, nSigs);
     }

   // Freshness: never act on a stale feed (cache/CDN hiccup) — manage only.
   bool stale = (g_feedTs > 0 && (TimeGMT() - (datetime)g_feedTs) > 180);

   AttachMissingPlans(sigs, nSigs);            // heal any position that missed its plan
   ManagePositions();                          // trail + partials (always)
   if(!dailyHalt && !stale) DoPyramiding(sigs, nSigs);   // add to winners (hedging only)
   if(!dailyHalt && !stale) for(int i=0;i<nSigs;i++) OpenBase(sigs[i]);
   CleanupPlans();                             // drop plans for closed tickets

   string capFlag = (g_maxOpenRisk<=0) ? " · CAPS PENDING (entries blocked)" : "";
   Comment(StringFormat("Shalobot MT5 v3.1 · %s · forex+volatility · %d signals · %s%s%s%s",
           ProfileStr(), nSigs, TimeToString(TimeCurrent(), TIME_SECONDS), dailyHalt?" · DAILY LOSS HALT":"", capFlag, stale?" · STALE FEED":""));
  }

//+------------------------------------------------------------------+
//| Parsing                                                          |
//+------------------------------------------------------------------+
void ParseCaps(string line)
  {
   // "# caps: maxOpenRisk=5 corrCap=2" — only accept positive values, and cache
   // the last-known-good (account-scoped) so a later header-less feed keeps limits.
   int p = StringFind(line, "maxOpenRisk=");
   if(p>=0) { double v=StringToDouble(StringSubstr(line, p+12)); if(v>0) { g_maxOpenRisk=v; GVset("ev_capmax"+AcctSuffix(), v); } }
   int q = StringFind(line, "corrCap=");
   if(q>=0) { double v=StringToDouble(StringSubstr(line, q+8)); if(v>0) { g_corrCap=v; GVset("ev_capcorr"+AcctSuffix(), v); } }
   int dl = StringFind(line, "dailyLoss=");
   if(dl>=0) { double v=StringToDouble(StringSubstr(line, dl+10)); if(v>0) { g_dailyLoss=v; GVset("ev_capdaily"+AcctSuffix(), v); } }
   // "ts=<unix seconds>" — the feed's generation time, for the staleness guard.
   int r = StringFind(line, "ts=");
   if(r>=0) { long v=StringToInteger(StringSubstr(line, r+3)); if(v>0) g_feedTs=v; }
  }

bool ParseLine(string line, Sig &s)
  {
   string f[];
   if(StringSplit(line, ',', f) < 8) return false;
   s.sym=f[0]; s.side=f[1];
   s.entry=StringToDouble(f[2]); s.sl=StringToDouble(f[3]); s.tp=StringToDouble(f[4]);
   s.risk=StringToDouble(f[5]);
   s.trail = (ArraySize(f)>8) ? StringToDouble(f[8]) : 0;
   s.nP=0; s.nA=0; s.clu="";
   if(ArraySize(f)>9  && f[9]!="-"  && f[9]!="")  ParsePairs(f[9],  s.pPrice, s.pPct, s.nP);
   if(ArraySize(f)>10 && f[10]!="-" && f[10]!="") ParsePairs(f[10], s.aPrice, s.aPct, s.nA);
   if(ArraySize(f)>11) s.clu=f[11];
   return true;
  }

void ParsePairs(string field, double &price[], double &val[], int &cnt)
  {
   cnt=0;
   string pairs[]; int n=StringSplit(field, ';', pairs);
   for(int i=0;i<n && cnt<8;i++)
     {
      string kv[];
      if(StringSplit(pairs[i], ':', kv) >= 2) { price[cnt]=StringToDouble(kv[0]); val[cnt]=StringToDouble(kv[1]); cnt++; }
     }
  }

//+------------------------------------------------------------------+
//| Entries                                                          |
//+------------------------------------------------------------------+
void OpenBase(Sig &s)
  {
   string sym = s.sym + InpSymbolSuffix;
   if(!SymbolSelect(sym, true)) return;
   if(HasOpenPosition(sym)) return;
   if(OnCooldown(sym)) return;
   if(!OpenRiskOk(s.clu, s.risk)) return;

   double ask=SymbolInfoDouble(sym,SYMBOL_ASK), bid=SymbolInfoDouble(sym,SYMBOL_BID);
   if(ask<=0 || bid<=0) return;
   double point=SymbolInfoDouble(sym,SYMBOL_POINT);
   if(point>0 && (ask-bid)/point > InpMaxSpreadPts) return;

   bool buy=(s.side=="buy");
   double price = buy ? ask : bid;
   if(buy  && !(s.sl<price && s.tp>price)) return;
   if(!buy && !(s.sl>price && s.tp<price)) return;
   double stopsLvl=(double)SymbolInfoInteger(sym,SYMBOL_TRADE_STOPS_LEVEL)*point;
   if(MathAbs(price-s.sl) < MathMax(InpMinStopPoints*point, stopsLvl)) return;

   double lots=LotsForRisk(sym, price, s.sl, s.risk);
   if(lots<=0) return;

   g_trade.SetTypeFillingBySymbol(sym);
   bool ok = buy ? g_trade.Buy(lots, sym, price, s.sl, s.tp, "shalo")
                 : g_trade.Sell(lots, sym, price, s.sl, s.tp, "shalo");
   if(ok)
     {
      GVset("ev_add_"+sym, 0);                 // reset pyramid counter for this symbol
      BindPlan(s, lots, s.risk);
      int d=(int)SymbolInfoInteger(sym,SYMBOL_DIGITS);
      PrintFormat("Shalobot %s %s %.2f lots @ %s SL %s TP %s", s.side, sym, lots,
                  DoubleToString(price,d), DoubleToString(s.sl,d), DoubleToString(s.tp,d));
     }
   else PrintFormat("Shalobot order failed %s %s: %d", s.side, sym, g_trade.ResultRetcode());
  }

void DoPyramiding(Sig &sigs[], int n)
  {
   if(!InpEnablePyramid) return;
   if((ENUM_ACCOUNT_MARGIN_MODE)AccountInfoInteger(ACCOUNT_MARGIN_MODE) != ACCOUNT_MARGIN_MODE_RETAIL_HEDGING) return;

   for(int k=0;k<n;k++)
     {
      if(sigs[k].nA==0) continue;
      string sym = sigs[k].sym + InpSymbolSuffix;
      if(!SymbolSelect(sym,true) || !HasOpenPosition(sym)) continue;
      bool buy=(sigs[k].side=="buy");
      if((BasePositionSide(sym)>0) != buy) continue;

      int done=(int)GVget("ev_add_"+sym, 0);
      if(done >= sigs[k].nA) continue;
      double apct=sigs[k].aPct[done];
      if(!OpenRiskOk(sigs[k].clu, apct)) continue;

      double ap=sigs[k].aPrice[done];
      double ask=SymbolInfoDouble(sym,SYMBOL_ASK), bid=SymbolInfoDouble(sym,SYMBOL_BID);
      // WINNER-side adds: the level sits beyond entry in the trade direction, so
      // we add only as the trade proves itself (bid/ask has ADVANCED to it).
      bool hit = buy ? (bid >= ap) : (ask <= ap);
      if(!hit) continue;

      double price = buy ? ask : bid;
      double point=SymbolInfoDouble(sym,SYMBOL_POINT);
      if(point>0 && (ask-bid)/point > InpMaxSpreadPts) continue;
      if(buy  && !(sigs[k].sl<price && sigs[k].tp>price)) continue;
      if(!buy && !(sigs[k].sl>price && sigs[k].tp<price)) continue;
      double stopsLvl=(double)SymbolInfoInteger(sym,SYMBOL_TRADE_STOPS_LEVEL)*point;
      if(MathAbs(price-sigs[k].sl) < MathMax(InpMinStopPoints*point, stopsLvl)) continue;

      double lots=LotsForRisk(sym, price, sigs[k].sl, apct);
      if(lots<=0) continue;

      g_trade.SetTypeFillingBySymbol(sym);
      bool ok = buy ? g_trade.Buy(lots, sym, price, sigs[k].sl, sigs[k].tp, "shalo-add")
                    : g_trade.Sell(lots, sym, price, sigs[k].sl, sigs[k].tp, "shalo-add");
      if(ok)
        {
         GVset("ev_add_"+sym, done+1);
         BindPlan(sigs[k], lots, apct);
         PrintFormat("Shalobot ADD #%d %s %s %.2f lots", done+1, sigs[k].side, sym, lots);
        }
     }
  }

// Bind the just-opened position (by its deal's position id) to its management plan.
void BindPlan(Sig &s, double lots, double riskPct)
  {
   ulong posTk=0;
   ulong deal=g_trade.ResultDeal();
   if(deal>0 && HistoryDealSelect(deal)) posTk=(ulong)HistoryDealGetInteger(deal, DEAL_POSITION_ID);
   if(posTk==0 || !PositionSelectByTicket(posTk)) posTk=FindUnplannedPosition(s.sym+InpSymbolSuffix);
   if(posTk>0) StorePlan(posTk, s, lots, riskPct);
   else PrintFormat("Shalobot: opened %s but could not bind plan yet (will retry next poll).", s.sym);
  }

// Total + per-cluster open-risk cap, enforced against the live book (incl. adds).
bool OpenRiskOk(string cluster, double newRisk)
  {
   if(g_maxOpenRisk<=0) return false;  // caps unknown → FAIL CLOSED (block new entries)
   double cid=ClusterId(cluster);
   double total=0, clus=0;
   for(int i=PositionsTotal()-1;i>=0;i--)
     {
      ulong tk=PositionGetTicket(i);
      if(tk==0 || PositionGetInteger(POSITION_MAGIC)!=InpMagic) continue;
      double r=GVget("ev_risk_"+(string)tk, 0);
      total+=r;
      if(GVget("ev_clu_"+(string)tk, -1)==cid) clus+=r;
     }
   if(total+newRisk > g_maxOpenRisk+1e-9) return false;
   if(g_corrCap>0 && clus+newRisk > g_corrCap+1e-9) return false;
   return true;
  }

//+------------------------------------------------------------------+
//| Management: trailing + partials                                  |
//+------------------------------------------------------------------+
void ManagePositions()
  {
   for(int i=PositionsTotal()-1;i>=0;i--)
     {
      ulong tk=PositionGetTicket(i);
      if(tk==0 || PositionGetInteger(POSITION_MAGIC)!=InpMagic) continue;
      if(InpEnablePartials) FirePartials(tk);
      if(InpEnableTrailing) TrailStop(tk);
     }
  }

void TrailStop(ulong tk)
  {
   if(!PositionSelectByTicket(tk)) return;
   double trail=GVget("ev_trail_"+(string)tk, 0);
   if(trail<=0) return;
   string sym=PositionGetString(POSITION_SYMBOL);
   long type=PositionGetInteger(POSITION_TYPE);
   double entry=PositionGetDouble(POSITION_PRICE_OPEN);
   double curSL=PositionGetDouble(POSITION_SL);
   double tp=PositionGetDouble(POSITION_TP);
   int digits=(int)SymbolInfoInteger(sym,SYMBOL_DIGITS);
   double point=SymbolInfoDouble(sym,SYMBOL_POINT);
   double stopsLvl=(double)SymbolInfoInteger(sym,SYMBOL_TRADE_STOPS_LEVEL)*point;
   double bid=SymbolInfoDouble(sym,SYMBOL_BID), ask=SymbolInfoDouble(sym,SYMBOL_ASK);

   if(type==POSITION_TYPE_BUY)
     {
      if(bid-entry < trail) return;                        // only trail once genuinely in profit
      double newSL=NormalizeDouble(bid-trail, digits);
      if(newSL > curSL+point && (bid-newSL) >= stopsLvl && newSL < bid)
         g_trade.PositionModify(tk, newSL, tp);
     }
   else
     {
      if(entry-ask < trail) return;
      double newSL=NormalizeDouble(ask+trail, digits);
      if((curSL==0 || newSL < curSL-point) && (newSL-ask) >= stopsLvl && newSL > ask)
         g_trade.PositionModify(tk, newSL, tp);
     }
  }

void FirePartials(ulong tk)
  {
   if(!PositionSelectByTicket(tk)) return;
   string sym=PositionGetString(POSITION_SYMBOL);
   int np=(int)GVget("ev_np_"+(string)tk, 0);
   int pf=(int)GVget("ev_pf_"+(string)tk, 0);
   if(pf>=np) return;
   double ov=GVget("ev_ov_"+(string)tk, 0);
   long type=PositionGetInteger(POSITION_TYPE);
   double bid=SymbolInfoDouble(sym,SYMBOL_BID), ask=SymbolInfoDouble(sym,SYMBOL_ASK);
   double vstep=SymbolInfoDouble(sym,SYMBOL_VOLUME_STEP);
   double vmin=SymbolInfoDouble(sym,SYMBOL_VOLUME_MIN);
   double remaining=PositionGetDouble(POSITION_VOLUME);   // track locally across levels

   for(int i=pf;i<np;i++)
     {
      double pp=GVget("ev_pp_"+(string)tk+"_"+(string)i, 0);
      double pc=GVget("ev_pc_"+(string)tk+"_"+(string)i, 0);
      bool hit = (type==POSITION_TYPE_BUY) ? (bid>=pp) : (ask<=pp);
      if(!hit) break;                                      // partials are ordered

      double vol = ov*pc/100.0;
      if(vstep>0) vol = MathFloor(vol/vstep)*vstep;
      double keep = remaining - vol;                       // runner left after this close
      if(vstep>0) keep = MathRound(keep/vstep)*vstep;      // kill float error (0.03-0.02!=0.01)
      if(vol>=vmin && keep>=vmin)                          // keep at least a min-lot runner
        {
         if(g_trade.PositionClosePartial(tk, vol)) { remaining-=vol; GVset("ev_pf_"+(string)tk, i+1); }
         else break;                                       // broker rejection → retry next poll
        }
      else GVset("ev_pf_"+(string)tk, i+1);                // too small to bank — mark done, don't loop forever
     }
  }

//+------------------------------------------------------------------+
//| Plan storage / cleanup                                           |
//+------------------------------------------------------------------+
void StorePlan(ulong tk, Sig &s, double ov, double riskPct)
  {
   string T=(string)tk;
   GVset("ev_trail_"+T, s.trail);
   GVset("ev_ov_"+T, ov);
   GVset("ev_np_"+T, s.nP);
   GVset("ev_pf_"+T, 0);
   GVset("ev_risk_"+T, riskPct);
   GVset("ev_clu_"+T, ClusterId(s.clu));
   for(int i=0;i<s.nP;i++) { GVset("ev_pp_"+T+"_"+(string)i, s.pPrice[i]); GVset("ev_pc_"+T+"_"+(string)i, s.pPct[i]); }
  }

void CleanupPlans()
  {
   for(int i=GlobalVariablesTotal()-1;i>=0;i--)
     {
      string name=GlobalVariableName(i);
      if(StringFind(name,"ev_trail_")!=0) continue;
      ulong tk=(ulong)StringToInteger(StringSubstr(name, 9));
      if(tk>0 && !PositionSelectByTicket(tk)) DeleteTicketGVs(tk);
     }
  }

void DeleteTicketGVs(ulong tk)
  {
   string T=(string)tk;
   GlobalVariableDel("ev_trail_"+T); GlobalVariableDel("ev_ov_"+T); GlobalVariableDel("ev_np_"+T);
   GlobalVariableDel("ev_pf_"+T);    GlobalVariableDel("ev_risk_"+T); GlobalVariableDel("ev_clu_"+T);
   for(int i=0;i<8;i++) { GlobalVariableDel("ev_pp_"+T+"_"+(string)i); GlobalVariableDel("ev_pc_"+T+"_"+(string)i); }
  }

// Attach a plan to any Shalobot position that has none yet (heals a missed bind).
void AttachMissingPlans(Sig &sigs[], int n)
  {
   for(int i=PositionsTotal()-1;i>=0;i--)
     {
      ulong tk=PositionGetTicket(i);
      if(tk==0 || PositionGetInteger(POSITION_MAGIC)!=InpMagic) continue;
      if(GlobalVariableCheck("ev_trail_"+(string)tk)) continue;
      string sym=PositionGetString(POSITION_SYMBOL);
      long type=PositionGetInteger(POSITION_TYPE);
      long posId=PositionGetInteger(POSITION_IDENTIFIER);
      double vol=OpeningVolume(posId);                     // true opening size, not the reduced current
      if(vol<=0) vol=PositionGetDouble(POSITION_VOLUME);
      for(int k=0;k<n;k++)
        {
         if(sigs[k].sym+InpSymbolSuffix != sym) continue;
         if((sigs[k].side=="buy") != (type==POSITION_TYPE_BUY)) continue;
         StorePlan(tk, sigs[k], vol, sigs[k].risk);
         break;
        }
     }
  }

// The original opening volume of a position (from its DEAL_ENTRY_IN deal), so a
// recovered plan sizes partials off the true size even after a partial fired.
double OpeningVolume(long posId)
  {
   if(!HistorySelectByPosition(posId)) return 0;
   for(int i=0;i<HistoryDealsTotal();i++)
     {
      ulong d=HistoryDealGetTicket(i);
      if(d==0) continue;
      if(HistoryDealGetInteger(d,DEAL_ENTRY)==DEAL_ENTRY_IN) return HistoryDealGetDouble(d,DEAL_VOLUME);
     }
   return 0;
  }

//+------------------------------------------------------------------+
//| Position helpers                                                 |
//+------------------------------------------------------------------+
bool HasOpenPosition(string sym)
  {
   for(int i=PositionsTotal()-1;i>=0;i--)
     {
      ulong tk=PositionGetTicket(i);
      if(tk==0) continue;
      if(PositionGetString(POSITION_SYMBOL)==sym && PositionGetInteger(POSITION_MAGIC)==InpMagic) return true;
     }
   return false;
  }

int BasePositionSide(string sym)
  {
   for(int i=PositionsTotal()-1;i>=0;i--)
     {
      ulong tk=PositionGetTicket(i);
      if(tk==0) continue;
      if(PositionGetString(POSITION_SYMBOL)==sym && PositionGetInteger(POSITION_MAGIC)==InpMagic)
         return (PositionGetInteger(POSITION_TYPE)==POSITION_TYPE_BUY) ? 1 : -1;
     }
   return 0;
  }

ulong FindUnplannedPosition(string sym)
  {
   ulong best=0; datetime bestT=0;
   for(int i=PositionsTotal()-1;i>=0;i--)
     {
      ulong tk=PositionGetTicket(i);
      if(tk==0) continue;
      if(PositionGetString(POSITION_SYMBOL)!=sym || PositionGetInteger(POSITION_MAGIC)!=InpMagic) continue;
      if(GlobalVariableCheck("ev_trail_"+(string)tk)) continue;
      datetime t=(datetime)PositionGetInteger(POSITION_TIME);
      if(t>=bestT) { bestT=t; best=tk; }
     }
   return best;
  }

//+------------------------------------------------------------------+
//| Re-entry cooldown (stamped on EXIT via OnTradeTransaction)       |
//+------------------------------------------------------------------+
string GVKey(string sym) { return "shalo_last_"+sym; }
bool OnCooldown(string sym)
  {
   if(InpReentryCooldownMin<=0) return false;
   string k=GVKey(sym);
   if(!GlobalVariableCheck(k)) return false;
   datetime last=(datetime)GlobalVariableGet(k);
   return (TimeCurrent()-last) < (long)InpReentryCooldownMin*60;
  }
void StampCooldown(string sym) { GlobalVariableSet(GVKey(sym), (double)TimeCurrent()); }

//+------------------------------------------------------------------+
//| Risk-based lot sizing off CURRENT balance + this symbol's specs  |
//+------------------------------------------------------------------+
double LotsForRisk(string sym, double price, double sl, double riskPct)
  {
   if(riskPct<=0) return 0;
   double balance   = AccountInfoDouble(ACCOUNT_BALANCE);
   double riskMoney = balance * riskPct / 100.0;
   double tickVal   = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_VALUE_LOSS);
   if(tickVal<=0) tickVal = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_VALUE);
   double tickSize  = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_SIZE);
   if(tickVal<=0 || tickSize<=0) return 0;

   double slDist = MathAbs(price - sl);
   double ticks  = slDist / tickSize;
   double lossPerLot = ticks * tickVal;
   if(lossPerLot<=0) return 0;

   double lots = riskMoney / lossPerLot;

   double vmin = SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN);
   double vmax = SymbolInfoDouble(sym, SYMBOL_VOLUME_MAX);
   double vstep= SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP);
   if(vstep>0) lots = MathFloor(lots/vstep)*vstep;
   if(lots < vmin) return 0;              // sub-minimum → skip, never up-size (that over-risks)
   lots = MathMin(vmax, lots);            // only ever clamp DOWN
   int vdig = (vstep>0) ? (int)MathRound(-MathLog10(vstep)) : 2;
   return NormalizeDouble(lots, vdig);
  }

//+------------------------------------------------------------------+
//| HTTP GET via WebRequest (URL must be whitelisted in the terminal)|
//+------------------------------------------------------------------+
string HttpGet(string url)
  {
   char post[]; char result[]; string headers;
   ResetLastError();
   int code = WebRequest("GET", url, "", 5000, post, result, headers);
   if(code==-1)
     {
      int err=GetLastError();
      if(err==4014 || err==4060) PrintFormat("WebRequest blocked — add https://www.shalobot.com in Tools>Options>Expert Advisors.");
      else PrintFormat("WebRequest error %d", err);
      return "";
     }
   if(code!=200) { PrintFormat("Signal feed HTTP %d", code); return ""; }
   return CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
  }
//+------------------------------------------------------------------+
