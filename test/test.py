from AutoComplete import *

print("Hello World!")
for item in Player.Backpack.Contains:
    print(f"Name: {item.Name}")

Player.Walk("East")
Player.Walk("East")
Player.Walk("East")
