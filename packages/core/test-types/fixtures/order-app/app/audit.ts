import type { OnPersonalDataAccess } from "@bounda-dev/core";

export const onPersonalDataAccess: OnPersonalDataAccess = ({ access, logger }) => {
  logger.info("personal data accessed", { ...access });
};
