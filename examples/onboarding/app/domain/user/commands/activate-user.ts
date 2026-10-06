import type { Command } from "./+types/activate-user";

export const payload = ({ z }: Command.PayloadArgs) => z.object({ userId: z.uuid() });

export const rejections = ({ command }: Command.RejectionsArgs) => ({
  Expired: `The registration of user ${command.aggregateId} has expired`,
  NotRegistered: `User ${command.aggregateId} does not exist`,
});

export const handler = ({ state, events, reject }: Command.HandlerArgs) => {
  switch (state.status) {
    case "registered":
      return [events.userActivated()];
    case "active":
      return [];
    case "expired":
      return reject("Expired");
    default:
      return reject("NotRegistered");
  }
};
