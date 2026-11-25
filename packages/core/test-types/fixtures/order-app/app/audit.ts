import type { OnHostRejection, OnPersonalDataAccess } from "@bounda-dev/core";

export const onPersonalDataAccess: OnPersonalDataAccess = ({ access, logger }) => {
  logger.info("personal data accessed", { ...access });
};

export const onHostRejection: OnHostRejection = ({ rejection, logger }) => {
  logger.info("request refused", { ...rejection });
};
