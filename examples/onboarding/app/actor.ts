import type { ActorFunction } from "@bounda-dev/react-router";
import { devActorOf } from "./dev-session.server.ts";

export const actor: ActorFunction = ({ request }) => devActorOf(request);
