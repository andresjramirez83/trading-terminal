import type { StudySnapshot } from "./snapshot/StudySnapshotBuilder";
import type { DecisionCenterBalance } from "./DecisionAnalysisTypes";

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function toneFromScore(score: number): "good" | "warn" | "bad" {
  if (score >= 70) return "good";
  if (score >= 45) return "warn";
  return "bad";
}

export function buildBalance(snapshot: StudySnapshot): DecisionCenterBalance {
  const structureStrength = snapshot.structure?.strength ?? 50;
  const compressionScore = snapshot.compression?.score ?? 50;
  const relativeVolume = snapshot.volume?.relative ?? 1;
  const price = snapshot.price?.close ?? 0;
  const vwap = snapshot.vwap?.value ?? price;

  const aboveVWAP = price >= vwap;

  const buyers = clamp(
    50 +
      (aboveVWAP ? 18 : -12) +
      (structureStrength - 50) * 0.35 +
      (relativeVolume - 1) * 12
  );

  const sellers = clamp(
    50 +
      (!aboveVWAP ? 18 : -12) +
      (50 - structureStrength) * 0.35 +
      (relativeVolume - 1) * 8
  );

  const equilibrium = clamp(
    100 -
      Math.abs(buyers - sellers) -
      Math.max(0, structureStrength - 55) * 0.35 -
      Math.max(0, compressionScore - 65) * 0.2
  );

  const directionalControl = Math.max(buyers, sellers);
  const score = clamp(directionalControl - equilibrium * 0.25);

  let badge = "Balanced";
  let subtitle = "Market is balanced with no clear directional control.";

  if (buyers >= 70 && buyers > sellers + 12) {
    badge = "Buyer Control";
    subtitle = "Buyers are controlling price and supporting directional continuation.";
  } else if (sellers >= 70 && sellers > buyers + 12) {
    badge = "Seller Control";
    subtitle = "Sellers are controlling price and limiting bullish continuation.";
  } else if (equilibrium >= 65) {
    badge = "Equilibrium";
    subtitle = "Price is rotating in balance. Wait for acceptance or rejection.";
  } else if (compressionScore >= 70) {
    badge = "Building Energy";
    subtitle = "Market is compressing and preparing for directional expansion.";
  }

  return {
    score,
    badge,
    subtitle,
    tone: toneFromScore(score),
    buyers,
    sellers,
    equilibrium,
  };
}