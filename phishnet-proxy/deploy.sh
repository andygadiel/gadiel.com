#!/bin/bash
# One-shot deploy of the phish.net CORS proxy as an AWS Lambda Function URL.
# Requires: aws CLI with credentials (run `aws login` or `aws configure` first).
# Usage: PHISHNET_API_KEY=... ./deploy.sh [region]
set -euo pipefail

API_KEY="${PHISHNET_API_KEY:?usage: PHISHNET_API_KEY=... ./deploy.sh [region]}"
REGION="${1:-us-east-1}"
CORS='{"AllowOrigins":["https://gadiel.com","https://www.gadiel.com"],"AllowMethods":["GET"],"MaxAge":86400}'
FN_NAME="phishnet-proxy"
ROLE_NAME="phishnet-proxy-role"
cd "$(dirname "$0")"

echo "==> Ensuring IAM role $ROLE_NAME"
if ! aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE_NAME" \
    --assume-role-policy-document '{
      "Version": "2012-10-17",
      "Statement": [{"Effect": "Allow", "Principal": {"Service": "lambda.amazonaws.com"}, "Action": "sts:AssumeRole"}]
    }' >/dev/null
  aws iam attach-role-policy --role-name "$ROLE_NAME" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  echo "    created; waiting for IAM propagation..."
  sleep 12
fi
ROLE_ARN=$(aws iam get-role --role-name "$ROLE_NAME" --query Role.Arn --output text)

echo "==> Packaging function"
rm -f function.zip
zip -q function.zip index.mjs

echo "==> Creating/updating Lambda $FN_NAME in $REGION"
if aws lambda get-function --function-name "$FN_NAME" --region "$REGION" >/dev/null 2>&1; then
  aws lambda update-function-code --function-name "$FN_NAME" --region "$REGION" \
    --zip-file fileb://function.zip >/dev/null
  aws lambda wait function-updated --function-name "$FN_NAME" --region "$REGION"
  aws lambda update-function-configuration --function-name "$FN_NAME" --region "$REGION" \
    --environment "Variables={PHISHNET_API_KEY=$API_KEY}" >/dev/null
else
  aws lambda create-function --function-name "$FN_NAME" --region "$REGION" \
    --runtime nodejs22.x --handler index.handler --role "$ROLE_ARN" \
    --zip-file fileb://function.zip --timeout 10 --memory-size 128 \
    --environment "Variables={PHISHNET_API_KEY=$API_KEY}" >/dev/null
fi
aws lambda wait function-active --function-name "$FN_NAME" --region "$REGION"

echo "==> Ensuring public Function URL with CORS for gadiel.com"
if aws lambda get-function-url-config --function-name "$FN_NAME" --region "$REGION" >/dev/null 2>&1; then
  aws lambda update-function-url-config --function-name "$FN_NAME" --region "$REGION" \
    --cors "$CORS" >/dev/null
else
  aws lambda create-function-url-config --function-name "$FN_NAME" --region "$REGION" \
    --auth-type NONE --cors "$CORS" >/dev/null
fi

# A public NONE-auth URL needs BOTH statements; the second is missing from most
# AWS doc examples and its absence causes a blanket 403.
aws lambda add-permission --function-name "$FN_NAME" --region "$REGION" \
  --statement-id public-url --action lambda:InvokeFunctionUrl \
  --principal '*' --function-url-auth-type NONE >/dev/null 2>&1 || true
aws lambda add-permission --function-name "$FN_NAME" --region "$REGION" \
  --statement-id public-url-invoke --action lambda:InvokeFunction \
  --principal '*' >/dev/null 2>&1 || true

URL=$(aws lambda get-function-url-config --function-name "$FN_NAME" --region "$REGION" \
  --query FunctionUrl --output text)
echo
echo "Function URL: $URL"
echo "Test it:      curl \"${URL}latest\""
