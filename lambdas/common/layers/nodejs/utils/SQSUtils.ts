import { MessageAttributeValue, SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";

let sqsClient : SQSClient | null = null;

function getClient() : SQSClient {
    if (!sqsClient) {
        sqsClient = new SQSClient();
    }
    return sqsClient;
}

export async function sendMessage(queueUrl : string, messageStringBody : string, messageAttributes? : Record<string, string | number | ArrayBuffer | Uint8Array>) {
    const client = getClient();
    const attrs : Record<string, MessageAttributeValue> = {}
    if (messageAttributes) {
        for (const attrname of Object.keys(messageAttributes)) {
            const valueToPut = messageAttributes[attrname];
            if (typeof valueToPut === "number") {
                attrs[attrname] = { DataType : "Number", StringValue : valueToPut.toString() }
            } else if (typeof valueToPut === "string") {
                attrs[attrname] = { DataType : "String",  StringValue : valueToPut }
            } else {
                attrs[attrname] = { DataType : "Binary", BinaryValue : (valueToPut instanceof Uint8Array) ? valueToPut : new Uint8Array(valueToPut) }
            }
        }
    }
    const res = await client.send(new SendMessageCommand({
        QueueUrl : queueUrl,
        MessageBody : messageStringBody,
        MessageAttributes : messageAttributes ? attrs : undefined
    }))
    if (res.$metadata.httpStatusCode == 200) {
        return { status : 200, message : "The message has been sent successfully", data : res.MessageId ?? "" }
    } else {
        return { status : res.$metadata.httpStatusCode ?? 500, message : "An error occurred while sending the message", data : "" }
    }
}