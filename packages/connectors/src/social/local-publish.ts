import type { SubjectRef } from "@forge/protocol";
import type { Database } from "@forge/store";
import type { InMemoryCredentialProvider } from "../credentials.js";
import { connectPublishAccount, listPublishAccounts } from "./accounts.js";

export const LOCAL_PUBLISH_ACCOUNT = {
  connectorId: "local-publish",
  connectorName: "本地发布",
  adapterKind: "local",
  accountId: "local-publish-account",
  accountName: "本地账号",
  credentialRef: "cred://local-publish",
} as const;

const LOCAL_PUBLISH_SECRET = "local-publish";

export function connectLocalPublishAccount(
  db: Database,
  credentials: InMemoryCredentialProvider,
  subject: SubjectRef,
) {
  credentials.put(LOCAL_PUBLISH_ACCOUNT.credentialRef, LOCAL_PUBLISH_SECRET);
  connectPublishAccount(db, { ...LOCAL_PUBLISH_ACCOUNT, subject });
  const account = listPublishAccounts(db, subject).find(
    (item) => item.accountId === LOCAL_PUBLISH_ACCOUNT.accountId,
  );
  if (!account) throw new Error("local publish account was not connected");
  return account;
}
