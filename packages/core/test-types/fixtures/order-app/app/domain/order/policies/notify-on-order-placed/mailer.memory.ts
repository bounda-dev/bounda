export default {
  sent: [] as string[],
  async send(to: string, message: string): Promise<void> {
    this.sent.push(`${to}: ${message}`);
  },
};
