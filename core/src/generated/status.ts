/* Generated from schema/common.schema.json. Do not edit. Run pnpm run generate. */
import type { Contact } from './contact.js';
import type { Project } from './project.js';
import type { WorkItem } from './work_item.js';

export const CONTACT_STATES = ["下書き","送信済み","回答待ち","対応中","完了","送らない"] as const satisfies readonly Contact['state'][];
export const PROJECT_STATES = ["未確認","進行中","保留","終了"] as const satisfies readonly Project['state'][];
export const ITEM_STATES = ["未確認","進行中","待ち","完了","保留"] as const satisfies readonly WorkItem['state'][];
export const WORK_ITEM_KINDS = ["開発","営業","運営"] as const satisfies readonly WorkItem['kind'][];
