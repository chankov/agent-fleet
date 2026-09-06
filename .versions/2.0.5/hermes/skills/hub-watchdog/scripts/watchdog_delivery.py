from watchdog_contract import gate_o_valid

def delivery_state(artifact):
 valid=gate_o_valid(artifact)
 return {'originDelivery':valid,'disposition':'origin-delivery-enabled' if valid else 'journal-only-no-steering'}
def deliver(artifact,route,message,adapter=None):
 # There is intentionally no built-in Hermes API. A live-proven adapter is required.
 if not gate_o_valid(artifact) or adapter is None: raise RuntimeError('origin delivery unavailable without live Gate O')
 if not isinstance(route,dict) or not {'channel','chatId','sessionId'}<=set(route): raise RuntimeError('invalid_origin_route')
 return adapter(route,message)
