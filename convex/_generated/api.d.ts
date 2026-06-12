/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as accounts from "../accounts.js";
import type * as ai from "../ai.js";
import type * as boards from "../boards.js";
import type * as calendarData from "../calendarData.js";
import type * as crons from "../crons.js";
import type * as lib from "../lib.js";
import type * as liveMail from "../liveMail.js";
import type * as mailCorpus from "../mailCorpus.js";
import type * as operations from "../operations.js";
import type * as rateLimits from "../rateLimits.js";
import type * as smart from "../smart.js";
import type * as suggestions from "../suggestions.js";
import type * as userData from "../userData.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  accounts: typeof accounts;
  ai: typeof ai;
  boards: typeof boards;
  calendarData: typeof calendarData;
  crons: typeof crons;
  lib: typeof lib;
  liveMail: typeof liveMail;
  mailCorpus: typeof mailCorpus;
  operations: typeof operations;
  rateLimits: typeof rateLimits;
  smart: typeof smart;
  suggestions: typeof suggestions;
  userData: typeof userData;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
