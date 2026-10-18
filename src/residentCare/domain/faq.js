export class Faq {
  constructor({ id, questionKey, answerKey }) {
    this.id = id;
    this.questionKey = questionKey;
    this.answerKey = answerKey;
  }
}

export class ChatTicket {
  constructor({ id, residentId, topic, status = 'Open', createdAt = new Date().toISOString() }) {
    this.id = id;
    this.residentId = residentId;
    this.topic = topic;
    this.status = status;
    this.createdAt = createdAt;
  }
}
