from tvscreener import stock, StockField
print("--- Checking Fields ---")
for field in StockField.search("moving"):
    print(field.name)
for field in StockField.search("MACD"):
    print(field.name)
for field in StockField.search("ATR"):
    print(field.name)
