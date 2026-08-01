// src/trading/intelligence/evaluators/ParticipationContextEvaluator.ts

import type { MarketContextComponent, MarketContextEvidence, MarketContextMetric, MarketContextReason } from "../types/MarketContextTypes";
import type { MarketContextEvaluation, MarketContextEvaluator, MarketContextEvaluatorContext } from "../MarketContextEngine";

export class ParticipationContextEvaluator implements MarketContextEvaluator {
  readonly id = "participation";
  readonly categories = ["volume","participation"] as const;

  evaluate(context: MarketContextEvaluatorContext): MarketContextEvaluation | null {
    const i:any = context.input.indicators ?? {};
    const volume = i.volume ?? context.input.bar.volume;
    const rvol = i.relativeVolume;
    const delta = i.volumeDelta;

    const evidence: MarketContextEvidence[] = [];
    const reasons: MarketContextReason[] = [];
    const metrics: MarketContextMetric[] = [];
    const tags:string[] = [];

    const metric=(key:string,label:string,value:any,unit?:string)=>metrics.push({
      key,label,category:"volume",value,unit,confidence:.8,timestamp:context.input.timestamp
    } as any);

    if(typeof volume==="number") metric("participation.volume","Volume",volume);
    if(typeof rvol==="number"){
      metric("participation.rvol","Relative Volume",rvol,"x");
      if(rvol>=2){
        tags.push("high-rvol");
        evidence.push({id:"high-rvol",category:"volume",label:"High RVOL",reason:"Participation is well above normal.",polarity:"positive",severity:"supporting",weight:1,scoreImpact:20,confidence:.85,source:this.id,timeframe:context.input.timeframe,timestamp:context.input.timestamp} as any);
      }else if(rvol<0.8){
        tags.push("low-rvol");
      }
    }
    if(typeof delta==="number"){
      metric("participation.delta","Volume Delta",delta);
    }

    if(!metrics.length && !evidence.length) return null;

    const component: MarketContextComponent = {
      id:"participation",
      category:"volume",
      label:"Participation",
      summary: tags.includes("high-rvol") ? "Strong market participation." : "Normal participation.",
      status:"confirmed",
      score: tags.includes("high-rvol") ? 78 : 55,
      normalizedScore: tags.includes("high-rvol") ? 78 : 55,
      confidence:.8,
      direction: typeof delta==="number" ? (delta>=0 ? "bullish":"bearish") : "neutral",
      reasons,
      evidence,
      metrics,
      tags,
      updatedAt:context.now,
    } as any;

    return {components:[component], evidence, reasons, metrics, tags};
  }
}

export default ParticipationContextEvaluator;
