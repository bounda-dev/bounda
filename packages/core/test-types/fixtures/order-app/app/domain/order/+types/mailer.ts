import type * as core from "@bounda-dev/core";
import type * as generated from "../../../../.bounda/types.ts";

type Ports = { readonly mailer: generated.OrderPorts["mailer"] };

export declare namespace Port {
  type Recipient = core.RecipientDeclaration;
  type OnPersonalDataForgottenArgs = core.RecipientForgottenArgs<Ports>;
  type OnProcessingRestrictedArgs = core.RecipientRestrictedArgs<Ports>;
  type OnProcessingRestrictionLiftAnnouncedArgs = core.RecipientLiftAnnouncedArgs<Ports>;
  type OnProcessingRestrictionLiftedArgs = core.RecipientLiftedArgs<Ports>;
  type OnPersonalDataRedactedArgs = core.RecipientRedactedArgs<Ports>;
  type OnTenantForgottenArgs = core.RecipientTenantForgottenArgs<Ports>;
}
