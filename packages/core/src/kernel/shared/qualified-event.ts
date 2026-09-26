export interface QualifiedEventTypeFunction {
  (aggregateType: string, eventType: string): string;
}

/**
 * The identity the kernel routes events by: the aggregate and the event type, `order.OrderPlaced`.
 * Two aggregates may name an event the same, so the type alone is not enough.
 */
export const qualifiedEventType: QualifiedEventTypeFunction = (aggregateType, eventType) =>
  `${aggregateType}.${eventType}`;
