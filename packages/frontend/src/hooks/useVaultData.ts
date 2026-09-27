import { useCallback, useEffect, useRef, useState } from "react";
import { backend, type ActivityEvent, type KeeperStatus, type QualificationSuite, type VaultState } from "../lib/api";
import { errorMessage } from "../lib/format";
import { DEPLOYMENT } from "../config";
import { publicClient, registryAbi } from "../lib/chain";

export type PublicQualification = { qualified: boolean; expiresAt: bigint };

export function useVaultData() {
  const [state, setState] = useState<VaultState | null>(null);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [keeper, setKeeper] = useState<KeeperStatus | null>(null);
  const [suite, setSuite] = useState<QualificationSuite | null>(null);
  const [qualification, setQualification] = useState<PublicQualification | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(true);
  const busy = useRef(false);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setRefreshing(true);
    const results = await Promise.allSettled([
      backend.state(),
      backend.activity(),
      backend.keeper(),
      backend.suite(),
      Promise.all([
        publicClient.readContract({ address: DEPLOYMENT.registry, abi: registryAbi, functionName: "isQualified", args: [DEPLOYMENT.agentId, DEPLOYMENT.operator, DEPLOYMENT.suiteHash] }),
        publicClient.readContract({ address: DEPLOYMENT.registry, abi: registryAbi, functionName: "qualifications", args: [DEPLOYMENT.agentId] }),
      ]),
    ] as const);
    if (results[0].status === "fulfilled") {
      setState(results[0].value);
      setError(null);
    } else {
      setError(errorMessage(results[0].reason));
    }
    if (results[1].status === "fulfilled") setActivity(results[1].value);
    if (results[2].status === "fulfilled") setKeeper(results[2].value);
    if (results[3].status === "fulfilled") setSuite(results[3].value);
    if (results[4].status === "fulfilled") setQualification({ qualified: results[4].value[0], expiresAt: results[4].value[1][4] });
    setRefreshing(false);
    busy.current = false;
  }, []);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  return { state, activity, keeper, suite, qualification, error, refreshing, refresh };
}
