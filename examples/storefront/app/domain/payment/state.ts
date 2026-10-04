export const initialState = {
  status: "new" as "new" | "requested" | "processing" | "settled" | "declined" | "cancelled",
  orderId: "",
  amount: 0,
  intentId: "",
  refund: "none" as "none" | "due" | "done",
};
