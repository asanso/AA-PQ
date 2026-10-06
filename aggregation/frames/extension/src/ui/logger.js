import { state } from "./state.js";
import { timestamp } from "../utils/format.js";

export function log(msg, type = "info") {
  state.logs.push({
    time: timestamp(),
    msg,
    type,
    id: Date.now() + Math.random(),
  });
}
