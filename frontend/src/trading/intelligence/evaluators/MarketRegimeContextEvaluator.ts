// src/trading/intelligence/evaluators/MarketRegimeContextEvaluator.ts

import type {
  MarketContextComponent,
  MarketContextEvidence,
  MarketContextMetric,
} from "../types/MarketContextTypes";
import type {
  MarketContextEvaluation,
  MarketContextEvaluator,
  MarketContextEvaluatorContext,
} from "../MarketContextEngine";

export type MarketRegime =
  | "trend"
  | "range"
  | "breakout"
  | "reversal"
  | "compression"
  | "expansion"
  | "transition"
  | "unknown";

export class MarketRegimeContextEvaluator implements MarketContextEvaluator {
  readonly id = "market-regime";
  readonly categories = ["regime","trend","risk"] as const;

  evaluate(context: MarketContextEvaluatorContext): MarketContextEvaluation | null {
    const i:any = context.input.indicators ?? {};
    const custom:any = i.custom?.regime ?? {};

    const regime: MarketRegime =
      custom.regime ??
      (custom.breakout ? "breakout" :
      custom.compression ? "compression" :
      custom.expansion ? "expansion" :
      custom.trending ? "trend" :
      custom.ranging ? "range" :
      custom.reversal ? "reversal" :
      "unknown");

    const confidence = Number.isFinite(custom.confidence) ? custom.confidence : 0.75;

    const evidence: MarketContextEvidence[] = [];
    const metrics: MarketContextMetric[] = [];
    const tags:string[] = ["regime", regime];

    const pushEvidence=(id:string,label:string,reason:string,polarity:any,impact:number)=>{
      evidence.push({
        id,
        category:"regime",
        label,
        reason,
        polarity,
        severity: polarity==="negative"?"warning":"supporting",
        weight:1,
        scoreImpact:impact,
        confidence,
        source:this.id,
        timeframe:context.input.timeframe,
        timestamp:context.input.timestamp,
      } as any);
    };

    switch(regime){
      case "trend":
        pushEvidence("trend","Trending Market","Directional conditions favor continuation.","positive",22);
        break;
      case "range":
        pushEvidence("range","Balanced Range","Mean reversion is favored over continuation.","neutral",12);
        break;
      case "compression":
        pushEvidence("compression","Compression","Energy is building before expansion.","neutral",18);
        break;
      case "breakout":
        pushEvidence("breakout","Breakout","Price is leaving balance with acceptance.","positive",24);
        break;
      case "reversal":
        pushEvidence("reversal","Potential Reversal","Trend exhaustion and reversal characteristics detected.","negative",20);
        break;
      case "expansion":
        pushEvidence("expansion","Expansion","Volatility expansion supports directional movement.","positive",18);
        break;
      case "transition":
        pushEvidence("transition","Transition","Market is shifting between regimes.","neutral",10);
        break;
    }

    metrics.push({
      key:"regime.type",
      label:"Market Regime",
      category:"regime",
      value:regime,
      confidence,
      timestamp:context.input.timestamp,
    } as any);

    if(regime==="unknown" && evidence.length===0) return null;

    const score =
      regime==="breakout" ? 90 :
      regime==="trend" ? 82 :
      regime==="expansion" ? 78 :
      regime==="compression" ? 65 :
      regime==="range" ? 58 :
      regime==="transition" ? 52 :
      regime==="reversal" ? 48 : 50;

    const component: MarketContextComponent = {
      id:"market-regime",
      category:"regime",
      label:"Market Regime",
      summary:`Current market regime: ${regime}.`,
      status:"confirmed",
      score,
      normalizedScore:score,
      confidence,
      direction:
        regime==="trend"||regime==="breakout"||regime==="expansion"
          ? "bullish"
          : regime==="reversal"
            ? "bearish"
            : "neutral",
      reasons:[],
      evidence,
      metrics:[{
        key:"regime.score",
        label:"Regime Score",
        category:"regime",
        value:score,
        score,
        confidence,
        timestamp:context.input.timestamp,
      } as any,...metrics],
      tags,
      updatedAt:context.now,
    } as any;

    return {
      components:[component],
      evidence,
      reasons:[],
      metrics:component.metrics,
      tags,
    };
  }
}

export default MarketRegimeContextEvaluator;
